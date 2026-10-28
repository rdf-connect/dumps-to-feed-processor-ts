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

describe("DumpsToFeed processor definition", () => {
  test("rdfc:DumpsToFeed falls back to its default values", async () => {
    const processorConfig = `
      @prefix rdfc: <https://w3id.org/rdf-connect#>.

      <http://example.com/ns#processor> a rdfc:DumpsToFeed;
        rdfc:output <jw>;
        rdfc:feedname "feed";
        rdfc:flush false;
        rdfc:dump <jr>;
        rdfc:dumpContentType "text/turtle";
        rdfc:focusNodesStrategy "extract";
        rdfc:nodeShapeIri "http://example.org/NodeShape".
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

  test("rdfc:dbDir can be written as an IRI", async () => {
    const helper = new ProcHelper<DumpsToFeed & Args>();

    await helper.importFile(path.resolve("./processor.ttl"));
    await helper.importInline(
      path.resolve("pipeline.ttl"),
      `
      @prefix rdfc: <https://w3id.org/rdf-connect#>.

      <http://example.com/ns#processor> a rdfc:DumpsToFeed;
        rdfc:output <jw>;
        rdfc:feedname "iri";
        rdfc:flush true;
        rdfc:dump <jr>;
        rdfc:dumpContentType "identifier";
        rdfc:focusNodesStrategy "extract";
        rdfc:nodeShapeIri "http://example.org/NodeShape";
        rdfc:dbDir <./state-of-iri-test/>.
    `,
    );
    helper.getConfig("DumpsToFeed");

    const processor = await helper.getProcessor(
      "http://example.com/ns#processor",
    );

    const dbDir = path.resolve("./state-of-iri-test/");

    // We received a named node. So the string is with a scheme and ends with '/' which is removed by path.resolve
    expect(processor.dbDir).toBe("file://" + dbDir + "/");
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
