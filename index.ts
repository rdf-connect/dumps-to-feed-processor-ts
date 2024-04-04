import rdfDereferencer from "rdf-dereference";
import {CBDShapeExtractor} from "extract-cbd-shape";
import {createHash} from 'node:crypto';
import {RdfStore} from 'rdf-stores';
import {DataFactory} from 'rdf-data-factory';
import {Parser, Writer as NWriter} from 'n3';
import {NamedNode, Term} from "@rdfjs/types";
import type {Stream, Writer} from "@ajuvercr/js-runner";
import {Level} from "level";
import {QueryEngine} from "@comunica/query-sparql";

const {canonize} = require('rdf-canonize');

const df: DataFactory = new DataFactory();
const parser = new Parser();
const engine = new QueryEngine();

// Helper function to make loading a quad stream in a store a promise
async function loadQuadStreamInStore(store: RdfStore, quadStream: any) {
  return new Promise((resolve, reject) => {
    store.import(quadStream).on("end", resolve).on("error", reject);
  });
}

function processActivity(writer: Writer<string>, quads: Array<any>, type: NamedNode, iri: NamedNode, hash: string) {
  let nWriter = new NWriter({"format": "application/trig"});
  // Create new relative IRI for the activity based on the hash of the activity
  let subject = df.namedNode("#" + hash);
  // Not sure what we need to include here: the tree:member? or sds:member?
  nWriter.addQuads([
    df.quad(df.namedNode("feed"), df.namedNode("https://w3id.org/tree#member"), subject),
    df.quad(subject, df.namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"), type),
    df.quad(subject, df.namedNode("https://www.w3.org/ns/activitystreams#object"), iri),
    df.quad(subject, df.namedNode("https://www.w3.org/ns/activitystreams#published"), df.literal((new Date()).toISOString(), df.namedNode('http://www.w3.org/2001/XMLSchema#dateTime'))),
  ]);

  for (let quad of quads) {
    nWriter.addQuad(quad.subject, quad.predicate, quad.object, subject);
  }

  nWriter.end(async (error, result) => {
    await writer.push(result);
  });
}

async function dumpToRdfStore(dump: string, dumpStrategy: 'identifier' | 'quads'): Promise<RdfStore> {
  const store = RdfStore.createDefault();
  switch (dumpStrategy) {
    case 'identifier':
      const {data} = await rdfDereferencer.dereference(dump, {localFiles: true});
      await loadQuadStreamInStore(store, data);
      break;
    case 'quads':
      for (const quad of parser.parse(dump)) {
        store.addQuad(quad);
      }
      break;
  }
  return store;
}

async function focusNodesToSubjects(store: RdfStore, focusNodesStrategy: 'extract' | 'sparql' | 'iris', focusNodes?: string): Promise<Term[]> {
  switch (focusNodesStrategy) {
    case 'extract':
      return findFocusNodes(store);
    case 'sparql':
      return findFocusNodes(store, focusNodes);
    case 'iris':
      if (!focusNodes) {
        console.error(`focusNodesStrategy is set to '${focusNodesStrategy}' but no focusNodes were provided`);
        return [];
      }
      return focusNodes.split(',').map((iri) => df.namedNode(iri));
  }
}

async function findFocusNodes(store: RdfStore, query?: string): Promise<Term[]> {
  query = query || `
  PREFIX dcat: <http://www.w3.org/ns/dcat#>
  PREFIX foaf: <http://xmlns.com/foaf/0.1/>
  PREFIX vcard: <http://www.w3.org/2006/vcard/ns#>
  PREFIX dcterms: <http://purl.org/dc/terms/>

  SELECT ?entity
  WHERE {
    ?entity a ?type .
    FILTER (?type IN (dcat:Catalog, dcat:Dataset, dcat:Distribution, dcat:DataService, foaf:Agent, vcard:Kind, dcterms:LicenseDocument))
  }
  `;

  const bindings = await (await engine.queryBindings(query, {sources: [store]})).toArray();
  // Map bindings to their terms and filter out undefined values
  return bindings.map((binding) => binding.get('entity')).filter((term) => term) as Term[];
}

/**
 * @param writer a writer to write the feed to
 * @param feedname the name of the feed
 * @param flush whether to flush the database
 * @param dump a filename, url, or serialized quads containing the data
 * @param dumpStrategy 'identifier'|'quads'. Use 'identifier' in case of filename or url, 'quads' in case of serialized quads
 * @param focusNodesStrategy 'extract'|'sparql'|'iris'. Use 'extract' in case of automatic extraction (we will use a SPARQL query to find and extract all nodes of one of the standalone entity types), 'sparql' in case of a provided SPARQL query, 'iris' in case of comma separated IRIs (NamedNode values)
 * @param nodeShapeIri if no nodeShapeStore was set, it will dereference the nodeShapeIri.
 * @param nodeShape serialized quads containing the node shape
 * @param focusNodes comma separated list of IRIs of the NamedNodes as subjects that should be extracted, or a SPARQL query resolving into a list of entities to be used as focus nodes
 */
export async function main(
  writer: Writer<string>,
  feedname: string,
  flush: boolean,
  dump: string,
  dumpStrategy: 'identifier' | 'quads',
  focusNodesStrategy: 'extract' | 'sparql' | 'iris',
  nodeShapeIri: string,
  nodeShape?: string,
  focusNodes?: string) {

  const db = new Level("state-of-" + feedname, {valueEncoding: 'json'});
  if (flush) {
    await db.clear();
  }
  const store = await dumpToRdfStore(dump, dumpStrategy);

  let nodeShapeStore;
  if (nodeShape) {
    nodeShapeStore = await dumpToRdfStore(nodeShape, 'quads');
  }

  // Create a shape for the entities in the stream and let’s extract them accordingly
  const extractor = new CBDShapeExtractor(nodeShapeStore);
  const subjects = await focusNodesToSubjects(store, focusNodesStrategy, focusNodes);
  const nodeShapeIriTerm = df.namedNode(nodeShapeIri);

  for (let subject of subjects) {
    if (subject.termType === 'BlankNode') {
      // Let's skip this entity
      console.error("An entity (type " + store.getQuads(subject, df.namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"), null)[0].object.value + ") cannot be a blank node!");
    } else if (subject.termType === 'NamedNode') {
      let entityQuads = await extractor.extract(store, subject, nodeShapeIriTerm);
      // Alright! We got an entity!
      // Now let's first create a hash to check whether the set of triples changed since last time.
      // We'll use a library to make the entity description canonized -- see https://w3c.github.io/rdf-canon/spec/
      let canonizedString = await canonize(entityQuads, {algorithm: 'RDFC-1.0'});

      // Now we can hash this string, for example with MD5
      let hashString = createHash('md5').update(canonizedString).digest('hex');

      // Now let's compare our hash with the hash in our leveldb key/val store.
      try {
        let previousHashString = await db.get(subject.value);
        if (previousHashString !== hashString) {
          // An Update!
          processActivity(writer, entityQuads, df.namedNode("https://www.w3.org/ns/activitystreams#Update"), subject, hashString);
          // We could also not await here, as there's nothing keeping us from continuing
          await db.put(subject.value, hashString);
        } else {
          // Remained the same: do nothing
          //console.log("Remained the same", subject);
        }
      } catch (e) {
        // PreviousHashString hasn't been set, so let's add a Create in our stream
        processActivity(writer, entityQuads, df.namedNode("https://www.w3.org/ns/activitystreams#Create"), subject, hashString);
        // We could also not await here, as there's nothing keeping us from continuing
        await db.put(subject.value, hashString);
      }
    }
  }
  // We still need to detect deletions: something that has been in our leveldb previously, but isn't anymore
  let keys = await db.keys().all();
  // Loop over the keys and check whether they are set in the store. If there are keys that weren't set before, it's a deletion!
  for (let key of keys) {
    if (store.getQuads(df.namedNode(key), null, null).length === 0) {
      processActivity(writer, [], df.namedNode("https://www.w3.org/ns/activitystreams#Delete"), df.namedNode(key), "deletion-" + encodeURIComponent(new Date().toISOString()));
      // and remove the entry in leveldb now, so it doesn't appear as removed twice in the feed on the next run
      await db.del(key);
    }
  }
}

/**
 * @param writer a writer to write the feed to
 * @param feedname the name of the feed
 * @param flush whether to flush the database
 * @param dump a filename, url, or serialized quads containing the data
 * @param dumpStrategy 'identifier'|'quads'. Use 'identifier' in case of filename or url, 'quads' in case of serialized quads
 * @param focusNodesStrategy 'extract'|'sparql'|'iris'. Use 'extract' in case of automatic extraction (we will use a SPARQL query to find and extract all nodes of one of the standalone entity types), 'sparql' in case of a provided SPARQL query, 'iris' in case of comma separated IRIs (NamedNode values)
 * @param nodeShapeIri if no nodeShapeStore was set, it will dereference the nodeShapeIri.
 * @param nodeShape quad stream containing the node shape
 * @param focusNodes comma separated list of IRIs of the NamedNodes as subjects that should be extracted, or a SPARQL query resolving into a list of entities to be used as focus nodes
 */
export async function processor(
  writer: Writer<string>,
  feedname: string,
  flush: boolean,
  dump: Stream<string>,
  dumpStrategy: 'identifier' | 'quads',
  focusNodesStrategy: 'extract' | 'sparql' | 'iris',
  nodeShapeIri: string,
  nodeShape?: Stream<string>,
  focusNodes?: Stream<string>) {

  const listenToNodeShape = !!nodeShape;
  const listenToFocusNodes = focusNodesStrategy === 'iris' || focusNodesStrategy === 'sparql';
  if (listenToFocusNodes && !focusNodes) {
    console.error(`focusNodesStrategy is set to '${focusNodesStrategy}' but no focusNodes were provided`);
    return;
  }
  const dumpBuffer: string[] = [];
  const nodeShapeBuffer: string[] = [];
  const focusNodesBuffer: string[] = [];

  let tryProcessing = async () => {
    while (dumpBuffer.length && (nodeShapeBuffer.length || !listenToNodeShape) && (focusNodesBuffer.length || !listenToFocusNodes)) {
      const nextDump = dumpBuffer.shift()!;
      const nextNodeShape = nodeShapeBuffer.shift();
      const nextFocusNodes = focusNodesBuffer.shift();
      await main(writer, feedname, flush, nextDump, dumpStrategy, focusNodesStrategy, nodeShapeIri, nextNodeShape, nextFocusNodes);
    }
  }

  dump.data(async (data) => {
    dumpBuffer.push(data);
    await tryProcessing();
  });

  if (listenToNodeShape) {
    nodeShape!.data(async (data) => {
      nodeShapeBuffer.push(data);
      await tryProcessing();
    });
  }

  if (listenToFocusNodes) {
    focusNodes!.data(async (data) => {
      focusNodesBuffer.push(data);
      await tryProcessing();
    });
  }
}
