# dumps-to-feed-processor-ts

A dumps to feed processor for the RDF Connect framework.

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
