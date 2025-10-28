import { rdfDereferencer } from "rdf-dereference";
import { CBDShapeExtractor } from "extract-cbd-shape";
import { createHash } from "node:crypto";
import { RdfStore } from "rdf-stores";
import { DataFactory } from "rdf-data-factory";
import { Writer as NWriter } from "n3";
import { NamedNode, ResultStream, Term } from "@rdfjs/types";
import { Processor, Reader, Writer } from "@rdfc/js-runner";
import { Level } from "level";
import { QueryEngine } from "@comunica/query-sparql";
import { rdfParser } from "rdf-parse";
import { arrayifyStream } from "arrayify-stream";
import streamifyString from "streamify-string";
import { streamifyArray } from "streamify-array";
import * as path from "path";
import { getLoggerFor } from "./utils/logUtil";
import Queue from "queue-fifo";
import { Readable } from "stream";
// @ts-ignore No type definitions available
import { canonize } from "rdf-canonize";

const logger = getLoggerFor("processor");

const df: DataFactory = new DataFactory();
const engine = new QueryEngine();

// Helper function to make loading a quad stream in a store a promise
async function loadQuadStreamInStore(store: RdfStore, quadStream: any) {
  return new Promise((resolve, reject) => {
    store.import(quadStream).on("end", resolve).on("error", reject);
  });
}

async function processActivity(
  writer: Writer,
  quads: Array<any>,
  type: NamedNode,
  iri: NamedNode,
  hash: string,
) {
  let nWriter = new NWriter({ format: "application/trig" });
  // Create new relative IRI for the activity based on the hash of the activity
  let subject = df.namedNode("#" + hash);
  nWriter.addQuads([
    df.quad(
      subject,
      df.namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),
      type,
    ),
    df.quad(
      subject,
      df.namedNode("https://www.w3.org/ns/activitystreams#object"),
      iri,
    ),
    df.quad(
      subject,
      df.namedNode("https://www.w3.org/ns/activitystreams#published"),
      df.literal(
        new Date().toISOString(),
        df.namedNode("http://www.w3.org/2001/XMLSchema#dateTime"),
      ),
    ),
  ]);

  for (let quad of quads) {
    nWriter.addQuad(quad.subject, quad.predicate, quad.object, subject);
  }

  return new Promise((resolve, reject) => {
    nWriter.end(async (error, result) => {
      await writer.string(result);
      resolve(undefined);
    });
  });
}

async function dumpToRdfStore(
  dump: string | Buffer,
  dumpContentType: string,
): Promise<RdfStore> {
  const store = RdfStore.createDefault();
  if (Buffer.isBuffer(dump)) {
    for (const quad of await arrayifyStream(
      rdfParser.parse(Readable.from(dump), { contentType: dumpContentType }),
    )) {
      store.addQuad(quad);
    }
  } else if (dumpContentType === "identifier") {
    const { data } = await rdfDereferencer.dereference(dump, {
      localFiles: true,
    });
    await loadQuadStreamInStore(store, data);
  } else {
    for (const quad of await arrayifyStream(
      rdfParser.parse(streamifyString(dump), { contentType: dumpContentType }),
    )) {
      store.addQuad(quad);
    }
  }
  return store;
}

async function focusNodesToSubjects(
  store: RdfStore,
  focusNodesStrategy: "extract" | "sparql" | "iris",
  focusNodes?: string,
): Promise<ResultStream<Term>> {
  switch (focusNodesStrategy) {
    case "extract":
      return findFocusNodes(store);
    case "sparql":
      return findFocusNodes(store, focusNodes);
    case "iris":
      if (!focusNodes) {
        logger.error(
          `[focusNodesToSubjects] focusNodesStrategy is set to '${focusNodesStrategy}' but no focusNodes were provided`,
        );
        return streamifyArray([]);
      }
      return streamifyArray(
        focusNodes.split(",").map((iri) => df.namedNode(iri)),
      );
  }
}

async function findFocusNodes(
  store: RdfStore,
  query?: string,
): Promise<ResultStream<Term>> {
  query =
    query ||
    `
  PREFIX dcat: <http://www.w3.org/ns/dcat#>
  PREFIX foaf: <http://xmlns.com/foaf/0.1/>
  PREFIX vcard: <http://www.w3.org/2006/vcard/ns#>
  PREFIX dcterms: <http://purl.org/dc/terms/>

  SELECT DISTINCT ?entity
  WHERE {
    ?entity a ?type .
    FILTER (?type IN (dcat:Catalog, dcat:Dataset, dcat:Distribution, dcat:DataService, foaf:Agent, vcard:Kind, dcterms:LicenseDocument))
  }
  `;

  const bindingsStream = await engine.queryBindings(query, {
    sources: [store],
  });

  // Map bindings to their terms and filter out undefined values
  return bindingsStream
    .map((bindings) => bindings.get("entity"))
    .filter((term) => term !== undefined) as ResultStream<Term>;
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
  writer: Writer,
  feedname: string,
  flush: boolean,
  dump: string | Buffer,
  dumpContentType: string,
  focusNodesStrategy: "extract" | "sparql" | "iris",
  nodeShapeIri: string,
  nodeShape?: string,
  focusNodes?: string,
  dbDir = "./",
) {
  const db = new Level(path.join(dbDir, "state-of-" + feedname), {
    valueEncoding: "json",
  });
  if (flush) {
    logger.info(`Flushing the database for feed ${feedname}.`);
    await db.clear();
  }
  const store = await dumpToRdfStore(dump, dumpContentType);

  let nodeShapeStore;
  if (nodeShape) {
    nodeShapeStore = await dumpToRdfStore(nodeShape, "text/turtle");
  }

  // Create a shape for the entities in the stream and let’s extract them accordingly
  const extractor = new CBDShapeExtractor(nodeShapeStore);
  const subjectsStream = await focusNodesToSubjects(
    store,
    focusNodesStrategy,
    focusNodes,
  );
  const nodeShapeIriTerm = df.namedNode(nodeShapeIri);

  let processing = 0;

  // We need a queue to process the entities in the stream sequentially, otherwise the data in the pipeline will be processed in parallel and race conditions will occur.
  const subjectsQueue = new Queue<Term>();
  let busy = false;
  subjectsStream.on("data", async (subjectToQueue: Term) => {
    subjectsQueue.enqueue(subjectToQueue);

    if (busy) {
      return;
    }
    busy = true;
    while (!subjectsQueue.isEmpty()) {
      const subject = subjectsQueue.dequeue()!;

      processing++;
      if (subject.termType === "BlankNode") {
        // Let's skip this entity
        logger.error(
          "An entity (" + subject.value + ") cannot be a blank node!",
        );
        processing--;
      } else if (subject.termType === "NamedNode") {
        let entityQuads = await extractor.extract(
          store,
          subject,
          nodeShapeIriTerm,
        );
        // Alright! We got an entity!
        // Now let's first create a hash to check whether the set of triples changed since last time.
        // We'll use a library to make the entity description canonized -- see https://w3c.github.io/rdf-canon/spec/
        let canonizedString = await canonize(entityQuads, {
          algorithm: "RDFC-1.0",
        });

        // Now we can hash this string, for example with MD5
        let hashString = createHash("md5")
          .update(canonizedString)
          .digest("hex");

        // Now let's compare our hash with the hash in our leveldb key/val store.
        let previousHashString = await db.get(subject.value);
        if (!previousHashString) {
          logger.debug(
            `No hash found in the db for '${subject.value}'. Processing a Create.`,
          );
          await db.put(subject.value, hashString);
          // PreviousHashString hasn't been set, so let's add a Create in our stream
          await processActivity(
            writer,
            entityQuads,
            df.namedNode("https://www.w3.org/ns/activitystreams#Create"),
            subject,
            hashString,
          );
        } else if (previousHashString !== hashString) {
          logger.debug(
            `Unequal hashes found in the db for '${subject.value}'. Processing an Update.`,
          );
          await db.put(subject.value, hashString);
          // An Update!
          await processActivity(
            writer,
            entityQuads,
            df.namedNode("https://www.w3.org/ns/activitystreams#Update"),
            subject,
            hashString,
          );
        } else {
          // Remained the same: do nothing
          logger.verbose(
            `Equal hashes found in the db for '${subject.value}'. Doing nothing.`,
          );
        }
        processing--;
      }
    }
    busy = false;
  });

  await new Promise((resolve, reject) => {
    subjectsStream.on("end", async () => {
      // Wait until all entities have been processed
      while (processing > 0) {
        logger.verbose("Waiting for processing to finish...");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // We still need to detect deletions: something that has been in our leveldb previously, but isn't anymore
      let keys = await db.keys().all();
      // Loop over the keys and check whether they are set in the store. If there are keys that weren't set before, it's a deletion!
      for (let key of keys) {
        if (store.getQuads(df.namedNode(key), null, null).length === 0) {
          logger.debug(
            `Key '${key}' was found in the db but not in the store. Processing a Delete.`,
          );

          await processActivity(
            writer,
            [],
            df.namedNode("https://www.w3.org/ns/activitystreams#Delete"),
            df.namedNode(key),
            "deletion-" + encodeURIComponent(new Date().toISOString()),
          );
          // and remove the entry in leveldb now, so it doesn't appear as removed twice in the feed on the next run
          await db.del(key);
        }
      }

      await db.close();
      logger.debug("Finished processing the stream. Closing the leveldb.");
      resolve(undefined);
    });

    subjectsStream.on("error", (e) => {
      logger.error(e);
      reject(e);
    });
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
export type Args = {
  writer: Writer;
  feedname: string;
  flush: boolean;
  dump: Reader;
  dumpContentType: string;
  focusNodesStrategy: "extract" | "sparql" | "iris";
  nodeShapeIri: string;
  nodeShape?: Reader;
  focusNodes?: Reader;
  dbDir: string; // = "./",
};
export class DumpsToFeeds extends Processor<Args> {
  private listenToNodeShape: boolean;
  private listenToFocusNodes: boolean;
  dumpBuffer: (string | Buffer)[] = [];
  nodeShapeBuffer: string[] = [];
  focusNodesBuffer: string[] = [];

  async tryProcessing(this: Args & this) {
    while (
      this.dumpBuffer.length &&
      (this.nodeShapeBuffer.length || !this.listenToNodeShape) &&
      (this.focusNodesBuffer.length || !this.listenToFocusNodes)
    ) {
      const nextDump = this.dumpBuffer.shift()!;
      const nextNodeShape = this.nodeShapeBuffer.shift();
      const nextFocusNodes = this.focusNodesBuffer.shift();
      await main(
        this.writer,
        this.feedname,
        this.flush,
        nextDump,
        this.dumpContentType,
        this.focusNodesStrategy,
        this.nodeShapeIri,
        nextNodeShape,
        nextFocusNodes,
        this.dbDir,
      );
    }
  }
  async init(this: Args & this): Promise<void> {
    this.dbDir = this.dbDir ?? "./";
    this.listenToFocusNodes = !!this.nodeShape;
    this.listenToFocusNodes =
      this.focusNodesStrategy === "iris" ||
      this.focusNodesStrategy === "sparql";
    if (this.listenToFocusNodes && !this.focusNodes) {
      logger.error(
        `focusNodesStrategy is set to '${this.focusNodesStrategy}' but no focusNodes were provided`,
      );
      return;
    }
  }
  async setupIncomingDumps(this: Args & this) {
    for await (const data of this.dump.strings()) {
      this.dumpBuffer.push(data);
      await this.tryProcessing();
    }
  }
  async setupListenToNodeShapes(this: Args & this) {
    if (this.nodeShape) {
      for await (const data of this.nodeShape.strings()) {
        this.nodeShapeBuffer.push(data);
        await this.tryProcessing();
      }
    }
  }
  async setupListenToFocusNodes(this: Args & this) {
    if (this.focusNodes) {
      for await (const data of this.focusNodes.strings()) {
        this.focusNodesBuffer.push(data);
        await this.tryProcessing();
      }
    }
  }
  async transform(this: Args & this): Promise<void> {
    await Promise.all([
      this.setupIncomingDumps(),
      this.setupListenToNodeShapes(),
      this.setupListenToFocusNodes(),
    ]);

    this.logger.info("All input streams ended, closing writer.");
    await this.writer.close();
  }
  async produce(this: Args & this): Promise<void> {}
}
