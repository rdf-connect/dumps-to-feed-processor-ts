import rdfDereferencer from "rdf-dereference";
import {CBDShapeExtractor} from "extract-cbd-shape";
import {createHash} from 'node:crypto';
import {RdfStore} from 'rdf-stores';
import {DataFactory} from 'rdf-data-factory';
import {Writer as NWriter} from 'n3';
import {NamedNode, ResultStream, Term} from "@rdfjs/types";
import type {Stream, Writer} from "@rdfc/js-runner";
import {Level} from "level";
import {QueryEngine} from "@comunica/query-sparql";
import rdfParser from "rdf-parse";
import arrayifyStream from "arrayify-stream";
import streamifyString from "streamify-string";
import streamifyArray from "streamify-array";
import * as path from "path";

const {canonize} = require('rdf-canonize');

const df: DataFactory = new DataFactory();
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
  nWriter.addQuads([
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

async function dumpToRdfStore(dump: string, dumpContentType: string): Promise<RdfStore> {
  const store = RdfStore.createDefault();
  if (dumpContentType === 'identifier') {
    const {data} = await rdfDereferencer.dereference(dump, {localFiles: true});
    await loadQuadStreamInStore(store, data);
  } else {
    for (const quad of await arrayifyStream(rdfParser.parse(streamifyString(dump), {contentType: dumpContentType}))) {
      store.addQuad(quad);
    }
  }
  return store;
}

async function focusNodesToSubjects(store: RdfStore, focusNodesStrategy: 'extract' | 'sparql' | 'iris', focusNodes?: string): Promise<ResultStream<Term>> {
  switch (focusNodesStrategy) {
    case 'extract':
      return findFocusNodes(store);
    case 'sparql':
      return findFocusNodes(store, focusNodes);
    case 'iris':
      if (!focusNodes) {
        console.error(`focusNodesStrategy is set to '${focusNodesStrategy}' but no focusNodes were provided`);
        return streamifyArray([]);
      }
      return streamifyArray(focusNodes.split(',').map((iri) => df.namedNode(iri)));
  }
}

async function findFocusNodes(store: RdfStore, query?: string): Promise<ResultStream<Term>> {
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

  const bindingsStream = await engine.queryBindings(query, {sources: [store]});

  // Map bindings to their terms and filter out undefined values
  return (bindingsStream.map((bindings) => bindings.get('entity')).filter((term) => term !== undefined)) as ResultStream<Term>;
}

/**
 * @param writer a writer to write the feed to
 * @param feedname the name of the feed
 * @param flush whether to flush the database
 * @param dump a filename, url, or serialized quads containing the data
 * @param dumpContentType the content type of the dump. Use 'identifier' in case of filename or url to be dereferenced
 * @param focusNodesStrategy 'extract'|'sparql'|'iris'. Use 'extract' in case of automatic extraction (we will use a SPARQL query to find and extract all nodes of one of the standalone entity types), 'sparql' in case of a provided SPARQL query, 'iris' in case of comma separated IRIs (NamedNode values)
 * @param nodeShapeIri if no nodeShapeStore was set, it will dereference the nodeShapeIri.
 * @param nodeShape serialized quads containing the node shape
 * @param focusNodes comma separated list of IRIs of the NamedNodes as subjects that should be extracted, or a SPARQL query resolving into a list of entities to be used as focus nodes
 * @param dbDir the directory where the leveldb will be stored. Default is "./"
 */
export async function main(
  writer: Writer<string>,
  feedname: string,
  flush: boolean,
  dump: string,
  dumpContentType: string,
  focusNodesStrategy: 'extract' | 'sparql' | 'iris',
  nodeShapeIri: string,
  nodeShape?: string,
  focusNodes?: string,
  dbDir = "./") {

  const db = new Level(path.join(dbDir, "state-of-" + feedname), {valueEncoding: 'json'});
  if (flush) {
    await db.clear();
  }
  const store = await dumpToRdfStore(dump, dumpContentType);

  let nodeShapeStore;
  if (nodeShape) {
    nodeShapeStore = await dumpToRdfStore(nodeShape, 'quads');
  }

  // Create a shape for the entities in the stream and let’s extract them accordingly
  const extractor = new CBDShapeExtractor(nodeShapeStore);
  const subjectsStream = await focusNodesToSubjects(store, focusNodesStrategy, focusNodes);
  const nodeShapeIriTerm = df.namedNode(nodeShapeIri);

  subjectsStream.on('data', async (subject: Term) => {
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
  });

  subjectsStream.on('end', async () => {
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
  });

  subjectsStream.on('error', (e) => {
    console.error(e);
  });
}

/**
 * @param writer a writer to write the feed to
 * @param feedname the name of the feed
 * @param flush whether to flush the database
 * @param dump a filename, url, or serialized quads containing the data
 * @param dumpContentType the content type of the dump. Use 'identifier' in case of filename or url to be dereferenced
 * @param focusNodesStrategy 'extract'|'sparql'|'iris'. Use 'extract' in case of automatic extraction (we will use a SPARQL query to find and extract all nodes of one of the standalone entity types), 'sparql' in case of a provided SPARQL query, 'iris' in case of comma separated IRIs (NamedNode values)
 * @param nodeShapeIri if no nodeShapeStore was set, it will dereference the nodeShapeIri.
 * @param nodeShape quad stream containing the node shape
 * @param focusNodes comma separated list of IRIs of the NamedNodes as subjects that should be extracted, or a SPARQL query resolving into a list of entities to be used as focus nodes
 * @param dbDir the directory where the leveldb will be stored. Default is "./"
 */
export async function processor(
  writer: Writer<string>,
  feedname: string,
  flush: boolean,
  dump: Stream<string>,
  dumpContentType: string,
  focusNodesStrategy: 'extract' | 'sparql' | 'iris',
  nodeShapeIri: string,
  nodeShape?: Stream<string>,
  focusNodes?: Stream<string>,
  dbDir = "./") {

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
      await main(writer, feedname, flush, nextDump, dumpContentType, focusNodesStrategy, nodeShapeIri, nextNodeShape, nextFocusNodes, dbDir);
    }
  }

  dump.data(async (data: string) => {
    dumpBuffer.push(data);
    await tryProcessing();
  });

  if (listenToNodeShape) {
    nodeShape!.data(async (data: string) => {
      nodeShapeBuffer.push(data);
      await tryProcessing();
    });
  }

  if (listenToFocusNodes) {
    focusNodes!.data(async (data: string) => {
      focusNodesBuffer.push(data);
      await tryProcessing();
    });
  }

  let dumpEnded = false;
  let nodeShapeEnded = false;
  let focusNodesEnded = false;
  let tryClosingWriter = () => {
    if (dumpEnded && nodeShapeEnded && focusNodesEnded) {
      writer.end();
    }
  }

  dump.on('end', async () => {
    dumpEnded = true;
    tryClosingWriter();
  });

  if (listenToNodeShape) {
    nodeShape!.on('end', async () => {
      nodeShapeEnded = true;
      tryClosingWriter();
    });
  } else {
    nodeShapeEnded = true;
  }

  if (listenToFocusNodes) {
    focusNodes!.on('end', async () => {
      focusNodesEnded = true;
      tryClosingWriter();
    });
  } else {
    focusNodesEnded = true;
  }
}
