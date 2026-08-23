import type { Env } from './env/types.js';
import { crawlAllCommand, crawlCommand } from './reading/crawl.js';
import { createCommand } from './authoring/create.js';
import { listCommand } from './authoring/list.js';
import { deleteCommand } from './authoring/delete.js';
import { publishCommand } from './authoring/publish.js';
import { scanCommand } from './reading/scan.js';
import { profileGroup } from './profiles/profile.js';

export interface Subcommand {
  name: string;
  description: string;
  usage: string;
  run(argv: string[], env: Env): Promise<number>;
}

export interface CommandGroup {
  name: string;
  description: string;
  usage: string;
  subcommands: Subcommand[];
}

/**
 * The single place commands are registered. Later issues plug new groups and
 * subcommands in here.
 */
export const groups: CommandGroup[] = [
  {
    name: 'feed',
    description: 'scan publications without authentication',
    usage: 'usage: substackctl feed <subcommand> [options]',
    subcommands: [scanCommand, crawlCommand, crawlAllCommand],
  },
  profileGroup,
  {
    name: 'post',
    description: 'author posts on your own publication',
    usage: 'usage: substackctl post <subcommand> [options]',
    subcommands: [createCommand, listCommand, deleteCommand, publishCommand],
  },
];
