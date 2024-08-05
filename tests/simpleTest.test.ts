import {assert} from "chai";
import {RdfStore} from "rdf-stores";
import {main} from "../src"
import * as N3 from "n3";
import {DataFactory} from "rdf-data-factory";
const df: DataFactory = new DataFactory();


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
   assert(members.length === 1, "expected one member in the case of a " + type);
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
      const feedname = 'test';

      let output = "";
      const writer = {
         push: async (data: string) => {
            output += data;
         },
         end: async () => {
         },
      };

      // Create
      const inputCreateFile = __dirname + "/inputCreate.ttl";

      await main(writer, feedname, true, inputCreateFile, 'identifier', 'extract', 'http://example.org/NodeShape', nodeShape);
      testCorrectness(output, "42", "https://www.w3.org/ns/activitystreams#Create")
   });

   it("Update a member", async () => {
      const feedname = 'test';

      let output = "";
      const writer = {
         push: async (data: string) => {
            output += data;
         },
         end: async () => {
         },
      };

      // Update
      const inputUpdateFile = __dirname + "/inputUpdate.ttl";

      await main(writer, feedname, false, inputUpdateFile, 'identifier', 'extract', 'http://example.org/NodeShape', nodeShape);
      testCorrectness(output, "43", "https://www.w3.org/ns/activitystreams#Update")
   });

   it("Delete a member", async () => {
      const feedname = 'test';

      let output = "";
      const writer = {
         push: async (data: string) => {
            output += data;
         },
         end: async () => {
         },
      };

      const inputDeleteFile = __dirname + "/inputDelete.ttl";

      await main(writer, feedname, false, inputDeleteFile, 'identifier', 'extract', 'http://example.org/NodeShape', nodeShape);
      testCorrectness(output, undefined, "https://www.w3.org/ns/activitystreams#Delete")
   });
});
