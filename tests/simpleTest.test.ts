import { RdfStore } from "rdf-stores";
import { channel, createRunner } from "@rdfc/js-runner/lib/testUtils/index.js";
import { main } from "../src/index.js";
import * as N3 from "n3";
import { DataFactory } from "rdf-data-factory";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createReadStream } from "fs";
import {describe, expect, test} from "vitest";
import {createLogger, format, transports} from "winston";

const df: DataFactory = new DataFactory();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function testCorrectness(log: string, value: string | undefined, type: string) {
   const parser = new N3.Parser();
   const quads = parser.parse(log);
   const store = RdfStore.createDefault();
   for (let quad of quads) {
      store.addQuad(quad);
   }

   const members = store.getQuads(null, df.namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"), df.namedNode(type)).map((quad) => {
      return quad.subject;
   });
   expect(members.length, `expected one member in the case of a ${type} (found ${members.length})`).toBe(1);
   const member = members[0];

   if (value) {
      //look up the value in the named graph
      const foundValue = store.getQuads(null, df.namedNode("http://example.org/value"), null, member).map((quad) => {
         return quad.object;
      });
      expect(foundValue[0].value, `expected correct value ${value}`).toBe(value);
   }

}

const logger = createLogger({
   format: format.combine(
      format.label({label: "dumps-to-feed"}),
      format.colorize(),
      format.timestamp(),
      format.metadata({
         fillExcept: ["level", "timestamp", "label", "message"],
      }),
      format.printf(
         ({
             level: levelInner,
             message,
             label: labelInner,
             timestamp,
          }): string =>
            `${timestamp} {dumps-to-feed} [${labelInner}] ${levelInner}: ${message}`,
      ),
   ),
   transports: [new transports.Console()],
});

describe("Simple test case with a create, a change and a removal", () => {

   const nodeShape = `
      @prefix sh:   <http://www.w3.org/ns/shacl#> .
@prefix ex:   <http://example.org/> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix dcat: <http://www.w3.org/ns/dcat#> .

ex:NodeShape
    a              sh:NodeShape ;
    sh:targetClass dcat:Catalog ;
    sh:property    [ sh:path     ex:value ;
                     sh:datatype xsd:integer ; ] .
`;

   test("Create a member", async () => {

      const runner = createRunner();
      const [writer, reader] = channel(runner, "channel");

      const feedname = 'test';

      let output = "";
      (async () => {
         for await (const st of reader.strings()) {
            output += st;
         }
      })().then();

      // Create
      const inputCreateFile = __dirname + "/inputCreate.ttl";

      await main(logger, writer, feedname, true, inputCreateFile, 'identifier', 'extract', 'http://example.org/NodeShape', nodeShape);
      testCorrectness(output, "42", "https://www.w3.org/ns/activitystreams#Create");
   });

   test("Update a member", async () => {
      const feedname = 'test';

      const runner = createRunner();
      const [writer, reader] = channel(runner, "channel");

      let output = "";
      (async () => {
         for await (const st of reader.strings()) {
            output += st;
         }
      })().then();

      // Update
      const inputUpdateFile = __dirname + "/inputUpdate.ttl";

      await main(logger, writer, feedname, false, inputUpdateFile, 'identifier', 'extract', 'http://example.org/NodeShape', nodeShape);
      testCorrectness(output, "43", "https://www.w3.org/ns/activitystreams#Update");
   });

   test("Delete a member", async () => {
      const feedname = 'test';

      const runner = createRunner();
      const [writer, reader] = channel(runner, "channel");

      let output = "";
      (async () => {
         for await (const st of reader.strings()) {
            output += st;
         }
      })().then();

      // Delete
      const inputDeleteFile = __dirname + "/inputDelete.ttl";

      await main(logger, writer, feedname, false, inputDeleteFile, 'identifier', 'extract', 'http://example.org/NodeShape', nodeShape);
      testCorrectness(output, undefined, "https://www.w3.org/ns/activitystreams#Delete");
   });

   test("Creates a member in a streaming way", async () => {

      const runner = createRunner();
      const [writer, reader] = channel(runner, "channel");

      const feedname = 'test';

      let output = "";
      (async () => {
         for await (const st of reader.strings()) {
            output += st;
         }
      })().then();

      // Create
      const inputCreateFile = createReadStream(__dirname + "/inputCreate.ttl");

      await main(
         logger,
         writer,
         feedname,
         true,
         inputCreateFile,
         'text/turtle',
         'extract',
         'http://example.org/NodeShape',
         nodeShape
      );
      testCorrectness(output, "42", "https://www.w3.org/ns/activitystreams#Create");
   });
});
