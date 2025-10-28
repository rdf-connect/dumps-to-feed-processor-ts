import {assert} from "chai";
import {RdfStore} from "rdf-stores";
import { channel, createRunner } from "@rdfc/js-runner/lib/testUtils";
import {main} from "../src"
import * as N3 from "n3";
import {DataFactory} from "rdf-data-factory";
import {fileURLToPath} from "node:url";
import path from "node:path";
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
   assert(members.length === 1, "expected one member in the case of a " + type + " (found " + members.length + ")");
   const member = members[0];

   if (value) {
      //look up the value in the named graph
      const foundValue = store.getQuads(null, df.namedNode("http://example.org/value"), null, member).map((quad) => {
         return quad.object;
      });
      assert(foundValue[0].value == value, "expected correct value " + value);
   }

}

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

   it("Create a member", async () => {

      const runner = createRunner();
      const [writer, reader] = channel(runner, "channel");

      const feedname = 'test';

      let output = "";
      (async () => {
          for await (const st of reader.strings()) {
              output += st;
          }
      })()

      // Create
      const inputCreateFile = __dirname + "/inputCreate.ttl";

      await main(writer, feedname, true, inputCreateFile, 'identifier', 'extract', 'http://example.org/NodeShape', nodeShape);
      testCorrectness(output, "42", "https://www.w3.org/ns/activitystreams#Create")
   });

   it("Update a member", async () => {
      const feedname = 'test';

      const runner = createRunner();
      const [writer, reader] = channel(runner, "channel");

      let output = "";
      (async () => {
          for await (const st of reader.strings()) {
              output += st;
          }
      })()

      // Update
      const inputUpdateFile = __dirname + "/inputUpdate.ttl";

      await main(writer, feedname, false, inputUpdateFile, 'identifier', 'extract', 'http://example.org/NodeShape', nodeShape);
      testCorrectness(output, "43", "https://www.w3.org/ns/activitystreams#Update")
   });

   it("Delete a member", async () => {
      const feedname = 'test';

      const runner = createRunner();
      const [writer, reader] = channel(runner, "channel");

      let output = "";
      (async () => {
          for await (const st of reader.strings()) {
              output += st;
          }
      })()
      const inputDeleteFile = __dirname + "/inputDelete.ttl";

      await main(writer, feedname, false, inputDeleteFile, 'identifier', 'extract', 'http://example.org/NodeShape', nodeShape);
      testCorrectness(output, undefined, "https://www.w3.org/ns/activitystreams#Delete")
   });
});
