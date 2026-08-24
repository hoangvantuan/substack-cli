import { parseArgv } from '../args.js';
import type { Subcommand } from '../commands.js';
import type { Env } from '../env/types.js';
import { EXIT_SUCCESS, UsageError } from '../exit.js';
import { DEFAULT_LIMIT, scanArchive, scanRecent, type PostSummary } from './feed.js';
import { publicationBaseUrl } from './publication.js';

export const scanUsage =
  'usage: sub-cli feed scan <publication> [--limit <n>] [--all] [--json] [--no-retry]';

export const scanCommand: Subcommand = {
  name: 'scan',
  description: 'scan the recent posts of any publication without authentication',
  usage: scanUsage,
  async run(argv, env) {
    const parsed = parseArgv(argv, {
      strings: ['limit'],
      booleans: ['all', 'json', 'no-retry'],
    });
    const publication = parsed.positionals[0];
    if (publication === undefined) {
      throw new UsageError('missing <publication>');
    }
    if (parsed.positionals.length > 1) {
      throw new UsageError(`unexpected argument: ${parsed.positionals[1]}`);
    }
    const all = parsed.values.get('all') === true;
    const limitRaw = parsed.values.get('limit');
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      if (all) {
        throw new UsageError('--limit cannot be combined with --all');
      }
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new UsageError(`--limit must be a positive integer: ${limitRaw}`);
      }
    }
    const base = publicationBaseUrl(publication);
    const retry = parsed.values.get('no-retry') !== true;
    const posts = all
      ? await scanArchive(env, base, retry)
      : await scanRecent(env, base, limit ?? DEFAULT_LIMIT, retry);
    if (parsed.values.get('json') === true) {
      env.stdout.write(JSON.stringify(posts, null, 2) + '\n');
    } else {
      writeTable(env, posts);
    }
    return EXIT_SUCCESS;
  },
};

function writeTable(env: Env, posts: PostSummary[]): void {
  if (posts.length === 0) {
    env.stdout.write('no posts found\n');
    return;
  }
  const header = ['POST_DATE', 'AUDIENCE', 'TITLE'];
  const rows = posts.map((post) => [
    (post.post_date ?? '').slice(0, 10) || '-',
    post.audience ?? '-',
    post.title ?? '',
  ]);
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => row[column]!.length)),
  );
  const lines = [
    header.map((label, column) => label.padEnd(widths[column]!)).join('  ').trimEnd(),
    ...rows.map((row) =>
      row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd(),
    ),
  ];
  env.stdout.write(lines.join('\n') + '\n');
}
