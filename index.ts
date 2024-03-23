import rdfDereferencer from "rdf-dereference";
import {CBDShapeExtractor} from "extract-cbd-shape";
const {canonize} = require('rdf-canonize');
import { createHash } from 'node:crypto';
import { RdfStore } from 'rdf-stores';
import { DataFactory } from 'rdf-data-factory';
import N3 from 'n3';
import { Quad, Term, NamedNode, BlankNode } from "@rdfjs/types";

const df: DataFactory = new DataFactory();

// Helper function to make loading a quad stream in a store a promise
let loadQuadStreamInStore = function (store: RdfStore, quadStream: any) {
    return new Promise((resolve, reject) => {
      store.import(quadStream).on("end", resolve).on("error", reject);
    });
}

let processActivity = function (quads: Array<any>, type: NamedNode, iri: NamedNode, hash:string) {
    // TODO: Instead of writing this to stdout as trig, we should use RDF Connect, so we can pipe it to an LDES server
    let writer = new N3.Writer({"format": "application/trig"});
    //create new relative IRI for the activity based on the hash of the activity
    let subject = df.namedNode("#" + hash);
    //Not sure what we need to include here: the tree:member? or sds:member? 
    writer.addQuads([
        df.quad(df.namedNode("feed"),df.namedNode("https://w3id.org/tree#member") , subject),
        df.quad(subject, df.namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"), type),
        df.quad(subject, df.namedNode("https://www.w3.org/ns/activitystreams#object"), iri),
        df.quad(subject, df.namedNode("https://www.w3.org/ns/activitystreams#published"), df.literal((new Date()).toISOString(), df.namedNode('http://www.w3.org/2001/XMLSchema#dateTime'))),
    ]);

    for (let quad of quads) {
        writer.addQuad(quad.subject,quad.predicate, quad.object, subject);
    }

    writer.end((error, result) => {
        console.log(result);
    });
}

/**
 * 
 * @param db a leveldb instance
 * @param feedname 
 * @param filename TODO: change this to an RDFStore with the data in it, so we can abstract away the parsing
 * @param focusNodes An array of nodes that should be extracted 
 * @param nodeShapeIri if no nodeShapeStore was set, it will dereference the nodeshapeiri. If not set, we will not do shape extraction but a simple CBD algorithm
 * @param nodeShapeStore 
 */
export async function main (db:any, feedname:string, filename:string, focusNodes: Term [], nodeShapeIri?: string, nodeShapeStore?: RdfStore) {
    const store: RdfStore = RdfStore.createDefault();;
    const { data } = await rdfDereferencer.dereference(filename, { localFiles: true });
    await loadQuadStreamInStore(store, data);
    //Todo: create a shape for the entities in the stream and let’s extract them accordingly
    let extractor = new CBDShapeExtractor();
    let subjects = focusNodes;

    for (let subject of subjects) {
        if (subject.termType === 'BlankNode') {
            console.error("An entity (type " + store.getQuads(subject, df.namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),null)[0].object.value + ") cannot be a blank node!");
            //Let’s skip this entity
            continue;
        } else if( subject.termType === 'NamedNode' ) {
            let entityquads = await extractor.extract(store, subject);
            // Alright! We got an entity!
            // Now let’s first create a hash to check whether the set of triples changed since last time.
            // We’ll use a library to make the entity description canonized -- see https://w3c.github.io/rdf-canon/spec/
            let canonizedString = await canonize(entityquads,{algorithm: 'RDFC-1.0'});
            //Now we can hash this string, for example with MD5
            let hashString = createHash('md5').update(canonizedString).digest('hex');
            //now let’s compare our hash with the hash in our leveldb key/val store.
            try {
                let previousHashString = await db.get(subject.value);            
                if (previousHashString !== hashString) {
                    //An Update!
                    processActivity(entityquads, df.namedNode("https://www.w3.org/ns/activitystreams#Update"), subject, hashString);
                    //We could also not await here, as there’s nothing keeping us from continuing
                    await db.put(subject.value,hashString);
                } else {
                    //Remained the same: do nothing
                    //console.log("Remained the same", subject);
                }
            } catch (e) {
                processActivity(entityquads, df.namedNode("https://www.w3.org/ns/activitystreams#Create"), subject, hashString);
                //PreviousHashString hasn’t been set, so let’s add a create in our stream
                //We could also not await here, as there’s nothing keeping us from continuing
                await db.put(subject.value,hashString);
            }
        }
    }
    //We still need to detect deletions: something that has been in our leveldb previously, but isn’t anymore
    let keys = await db.keys().all();
    //loop over the keys and check whether they are set in the store. If there are keys that weren’t set before, it’s a deletion!
    for (let key of keys) {        
        if (store.getQuads(df.namedNode(key),null,null).length === 0) {
            processActivity([], df.namedNode("https://www.w3.org/ns/activitystreams#Delete"), df.namedNode(key), "deletion-" + encodeURIComponent(new Date().toISOString()));
            //and remove the entry in leveldb now so it doesn’t appear as removed twice in the feed on the next run
            await db.del(key);
        }
    }
}
