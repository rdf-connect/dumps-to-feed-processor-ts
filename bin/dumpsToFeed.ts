import {program} from 'commander';
import {main} from "../index";

program
  .name('dumps-to-feed')
  .description('Translates a dump into a feed')
  .version('0.0.0');

program.argument('<feedname>', 'name of the feed you want to update')
  .argument('<filename>', 'filename of the dump')
  .option('-f, --flush') //TODO: add parameters for setting the shapes and strategy to extract focus nodes.
  .action(async (feedname: string, filename: string, options: any) => {
    //TODO: add the other parameters
    await main(feedname, options.flush, filename, []);
  });

program.parse();
