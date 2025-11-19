# dumps-to-feed-processor-ts
[![Build and tests with Node.js](https://github.com/rdf-connect/dumps-to-feed-processor-ts/actions/workflows/build-test.yml/badge.svg)](https://github.com/rdf-connect/dumps-to-feed-processor-ts/actions/workflows/build-test.yml) [![npm](https://img.shields.io/npm/v/@rdfc/dumps-to-feed-processor-ts.svg?style=popout)](https://npmjs.com/package/@rdfc/dumps-to-feed-processor-ts)

A dumps to feed processor for the [RDF Connect framework](https://github.com/rdf-connect).
It can be run as part of a pipeline using the [js-runner](https://github.com/rdf-connect/js-runner), or as a standalone CLI tool.

This processor is used to convert a dump of RDF data to a feed of RDF data.
As input, it takes a dump of RDF data and a SHACL shape that describes the members of the feed.
It will perform the [member extraction algorithm](https://github.com/TREEcg/extract-cbd-shape) using [CBD](https://www.w3.org/submissions/CBD/) and the SHACL shape to extract the members from the dump.
The extracted members are then compared to the members of the previous version of the dump to determine which members are new, updated, or deleted.
To compare the members, the processor first normalizes the members using the [RDF Dataset Canonicalization (RDFC-1.0)](https://w3c.github.io/rdf-canon/spec/) algorithm, and then hashes the normalized members using the MD5 algorithm.
For a new member, the processor will add the member to the feed as an `as:Create` activity.
For an updated member, the processor will add the member to the feed as an `as:Update` activity.
A deleted member will be added to the feed as an `as:Delete` activity.
The ActivityStreams 2.0 ontology (`https://www.w3.org/ns/activitystreams#`) is used to describe the activities in the feed.

Under the hood, a file-based LevelDB database is used to store the members of the previous version of the dump.
This database is used to compare the members of the new dump with the members of the previous dump.


## How to run

### Clone, install and build
```bash
git clone git@github.com:rdf-connect/dumps-to-feed-processor-ts.git
cd dumps-to-feed-feed-processor-ts
npm install
npm run build
```

### Install from npm

```bash
npm install @rdfc/dumps-to-feed-processor-ts
```

### Run the CLI version

```bash
node . sweden https://admin.dataportal.se/all.rdf https://semiceu.github.io/LDES-DCAT-AP-feeds/shape.ttl\#ActivityShape -o feed.ttl
```

### Run the example pipeline

An example pipeline configuration is provided in the `example` folder. You can run it with the following command:

```bash
npx js-runner example/pipeline.ttl
```


## Configuration

The processor can be configured using the following parameters:

- `writer`: A writer to write the output feed to.
- `feedname`: The name of the feed. Used internally to store the previous version of the feed such that you can use the processor for multiple feeds.
- `flush`: Whether to flush the previous version of the feed. If set to `true`, the processor will start with an empty feed and add all members from the dump as `as:Create` activities.
- `dump`: A filename, URL, or serialized quads containing the dump of RDF data.
- `dumpContentType`: The content type of the dump. Use 'identifier' in case of filename or url to be dereferenced.
- `readAsStream`: Read the RDF dump data in a stream fashion. Useful when reading too large dumps.
- `focusNodesStrategy`: `extract`, `sparql`, or `iris`. Use `extract` in case of automatic extraction (we will use a SPARQL query to find and extract all nodes of one of the [DCAT-AP Feeds standalone entity types](https://semiceu.github.io/LDES-DCAT-AP-feeds/index.html#standalone-entities)), `sparql` in case of a provided SPARQL query, 'iris' in case of comma separated IRIs (NamedNode values)
- `nodeShapeIri`: The IRI of the SHACL shape that describes the members of the feed.
- `nodeShape`: The serialized SHACL shape in `text/turtle` format that describes the members of the feed. Optional.
- `focusNodes`: Comma separated list of IRIs of the NamedNodes as subjects that should be extracted, or a SPARQL query resolving into a list of entities to be used as focus nodes. Exact value depends on value of `focusNodesStrategy`. Optional.
- `dbDir`: The directory where the leveldb will be stored. Default is "./"

The SHACL definition of the processor can be found in [`processor.ttl`](processor.ttl).


## Example

An example pipeline configuration is provided in the `example` folder: [`example/pipeline.ttl`](example/pipeline.ttl).

A full example of the processor in action for the Swedish DCAT-AP dump can be found [here](https://github.com/smessie/DCAT-AP-Feeds/blob/main/sweden/dumps-to-feed-pipeline.ttl).
This pipeline also contains the other processors set up to provide the dumps-to-feed-processor with the necessary data, and the processors to then write and publish the feed as a Linked Data Event Stream.
