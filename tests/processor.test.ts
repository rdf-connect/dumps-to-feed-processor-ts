import { describe, expect, test } from "vitest";
import { ProcHelper } from "@rdfc/js-runner/lib/testUtils/index.js";
import path from "node:path";
import type { Args, DumpsToFeed } from "../src/index.js";

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
});
