import { describe, expect, test } from "vitest";
import {
  channel,
  createRunner,
  ProcHelper,
} from "@rdfc/js-runner/lib/testUtils/index.js";
import path from "node:path";
import { existsSync, rmSync } from "node:fs";
import { createLogger, transports } from "winston";
import { main, type Args, type DumpsToFeed } from "../src/index.js";
import { pathToFileURL } from "node:url";

describe("DumpsToFeed processor definition", () => {
  test("rdfcp:DumpsToFeed falls back to its default values", async () => {
    const processorConfig = `
      @prefix rdfc: <https://w3id.org/rdf-connect#>.
      @prefix rdfcp: <https://w3id.org/rdf-connect/processors#>.

      <http://example.com/ns#processor> a rdfcp:DumpsToFeed;
        rdfcp:output <jw>;
        rdfcp:feedname "feed";
        rdfcp:flush false;
        rdfcp:input <jr>;
        rdfcp:dumpContentType "text/turtle";
        rdfcp:focusNodesStrategy "extract";
        rdfcp:nodeShapeIri "http://example.org/NodeShape".
    `;

    const helper = new ProcHelper<DumpsToFeed & Args>();

    await helper.importFile(path.resolve("./processor.ttl"));
    await helper.importInline(path.resolve("pipeline.ttl"), processorConfig);
    helper.getConfig("DumpsToFeed");

    const processor = await helper.getProcessor(
      "http://example.com/ns#processor",
    );

    expect(processor.feedname).toBe("feed");
    expect(processor.dbDir).toBe("./");
    expect(processor.readAsStream).toBe(false);
  });

  test("rdfcp:dbDir can be written as an IRI", async () => {
    const helper = new ProcHelper<DumpsToFeed & Args>();

    await helper.importFile(path.resolve("./processor.ttl"));
    await helper.importInline(
      path.resolve("pipeline.ttl"),
      `
      @prefix rdfc: <https://w3id.org/rdf-connect#>.
      @prefix rdfcp: <https://w3id.org/rdf-connect/processors#>.

      <http://example.com/ns#processor> a rdfcp:DumpsToFeed;
        rdfcp:output <jw>;
        rdfcp:feedname "iri";
        rdfcp:flush true;
        rdfcp:input <jr>;
        rdfcp:dumpContentType "identifier";
        rdfcp:focusNodesStrategy "extract";
        rdfcp:nodeShapeIri "http://example.org/NodeShape";
        rdfcp:dbDir <./state-of-iri-test/>.
    `,
    );
    helper.getConfig("DumpsToFeed");

    const processor = await helper.getProcessor(
      "http://example.com/ns#processor",
    );

    const dbDir = path.resolve("./state-of-iri-test/");

    expect(processor.dbDir).toBe(pathToFileURL(dbDir).href + "/");
    rmSync(dbDir, { recursive: true, force: true });

    const runner = createRunner();
    const [writer, reader] = channel(runner, "channel");
    (async () => {
      for await (const _ of reader.strings()) {
        // drain the feed
      }
    })().then();

    try {
      await main(
        createLogger({ transports: [new transports.Console()] }),
        writer,
        processor.feedname,
        processor.flush,
        path.resolve("./tests/inputCreate.ttl"),
        processor.dumpContentType,
        processor.focusNodesStrategy,
        processor.nodeShapeIri,
        `@prefix sh: <http://www.w3.org/ns/shacl#>.
        <http://example.org/NodeShape> a sh:NodeShape;
          sh:targetClass <http://www.w3.org/ns/dcat#Catalog>.`,
        undefined,
        processor.dbDir,
      );

      expect(existsSync(path.join(dbDir, "state-of-iri"))).toBe(true);
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
