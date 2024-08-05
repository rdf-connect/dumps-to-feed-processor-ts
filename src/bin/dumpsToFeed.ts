#!/usr/bin/env node

import {program} from 'commander';
import {main} from "../index";
import * as fs from "fs/promises";

program
  .name('dumps-to-feed')
  .description('Translates a dump into a feed')
  .version('0.0.0');

program.argument('<feedname>', 'name of the feed you want to update')
  .argument('<dump>', 'filename, url, or serialized quads containing the dump')
  .argument('<nodeShapeIri>', 'IRI of the nodeShape')
  .option('-f, --flush')
  .option('-dct, --dumpContentType <dumpContentType>', "The content type of the dump. Use 'identifier' in case of filename or url to be dereferenced", 'identifier')
  .option('-fns, --focusNodesStrategy <focusNodesStrategy>', "Use 'extract' in case of automatic extraction (we will use a SPARQL query to find and extract all nodes of one of the standalone entity types), 'sparql' in case of a provided SPARQL query, 'iris' in case of comma separated IRIs (NamedNode values)", 'extract')
  .option('-fn, --focusNodes <focusNode>', "comma separated list of IRIs of the NamedNodes as subjects that should be extracted, or a SPARQL query resolving into a list of entities to be used as focus nodes")
  .option('-s, --nodeShape <nodeShape>', "serialized quads containing the node shape")
  .option('-o, --out <filepath>', "File where the feed will be appended to. Default stdout")
  .option('-d, --dbDir <dbDir>', "Directory where the leveldb will be stored. Default ./db")
  .action(async (feedname: string, dump: string, nodeShapeIri: string, options: any) => {

    const writer = {
      push: async (data: string) => {
        if (options.out) {
          await fs.appendFile(options.out, data);
        } else {
          console.log(data);
        }
      },
      end: async () => {
      },
    };

    // We should not await main here, so the reader can push data before main is awaited.
    await main(writer, feedname, options.flush, dump, options.dumpContentType, options.focusNodesStrategy, nodeShapeIri, options.nodeShape, options.focusNodes, options.dbDir);
  });

program.parse();
