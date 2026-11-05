import { describe, expect, test } from "vitest";
import { channel, createRunner } from "@rdfc/js-runner/lib/testUtils/index.js";
import type { FullProc } from "@rdfc/js-runner";
import { readFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import { createLogger, transports } from "winston";
import { DumpsToFeed } from "../src/index.js";

const NODE_SHAPE = `@prefix sh: <http://www.w3.org/ns/shacl#>.
<http://example.org/NodeShape> a sh:NodeShape;
  sh:targetClass <http://www.w3.org/ns/dcat#Catalog>.`;

describe("DumpsToFeed processor with a node shape channel", () => {
  test("waits for the node shape before processing a dump", async () => {
    const dbDir = path.resolve("./state-of-node-shape-test/");
    rmSync(dbDir, { recursive: true, force: true });

    const runner = createRunner();
    const [dumpWriter, dumpReader] = channel(runner, "dump");
    const [shapeWriter, shapeReader] = channel(runner, "shape");
    const [feedWriter, feedReader] = channel(runner, "feed");

    const feed: string[] = [];
    const feedDone = (async () => {
      for await (const msg of feedReader.strings()) {
        feed.push(msg);
      }
    })();

    const proc = new DumpsToFeed(
      {
        writer: feedWriter,
        feedname: "node-shape",
        flush: true,
        dump: dumpReader,
        readAsStream: false,
        dumpContentType: "text/turtle",
        focusNodesStrategy: "extract",
        // Not resolvable: the shape must come from the node shape channel.
        nodeShapeIri: "http://example.org/NodeShape",
        nodeShape: shapeReader,
        dbDir,
      },
      createLogger({ transports: [new transports.Console({ level: "error" })] }),
    ) as FullProc<DumpsToFeed>;

    try {
      await proc.init();
      const transformed = proc.transform();

      // The dump arrives before the node shape.
      await dumpWriter.string(await readFile("./tests/inputCreate.ttl", "utf8"));
      await shapeWriter.string(NODE_SHAPE);
      await dumpWriter.close();
      await shapeWriter.close();

      await transformed;
      await feedDone;

      // The node shape was used for the dump, instead of being left unused.
      expect(proc.nodeShapeBuffer).toEqual([]);
      expect(feed.join("\n")).toContain(
        "https://www.w3.org/ns/activitystreams#Create",
      );
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
