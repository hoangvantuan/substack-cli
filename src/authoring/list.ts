import { parseArgv } from '../args.js';
import type { Subcommand } from '../commands.js';
import type { Env } from '../env/types.js';
import { EXIT_AUTH, EXIT_SUCCESS, UsageError } from '../exit.js';
import { loadConfig } from '../profiles/config.js';
import { resolveProfile, warnIfCookieStale } from '../profiles/resolve.js';
import {
  AuthError,
  DRAFTS_MAX_LIMIT,
  POST_MANAGEMENT_MAX_LIMIT,
  SubstackClient,
  type AuthoringPost,
  type PostState,
} from './api.js';

export const listUsage =
  'usage: substackctl post list [--state <draft|scheduled|published>] [--limit <n>]\n' +
  '                             [--json] [--profile <name>] [--no-retry]';

export const DEFAULT_LIMIT = 10;

const STATES: Record<string, true> = { draft: true, scheduled: true, published: true };

export const listCommand: Subcommand = {
  name: 'list',
  description: 'list this publication\'s posts by state',
  usage: listUsage,
  async run(argv, env) {
    const parsed = parseArgv(argv, {
      strings: ['state', 'limit', 'profile'],
      booleans: ['json', 'no-retry'],
    });
    if (parsed.positionals.length > 0) {
      throw new UsageError(`unexpected argument: ${parsed.positionals[0]}`);
    }
    const stateRaw = parsed.values.get('state');
    const state = typeof stateRaw === 'string' ? stateRaw : 'draft';
    if (!(state in STATES)) {
      throw new UsageError(`invalid state "${state}": expected draft, scheduled, or published`);
    }
    const limitRaw = parsed.values.get('limit');
    let limit = DEFAULT_LIMIT;
    if (typeof limitRaw === 'string') {
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new UsageError(`--limit must be a positive integer: ${limitRaw}`);
      }
    }
    const config = await loadConfig(env);
    const profileName = parsed.values.get('profile');
    const profile = resolveProfile(env, config, typeof profileName === 'string' ? profileName : undefined);
    warnIfCookieStale(env, profile);
    const client = new SubstackClient(
      env,
      profile.publication,
      profile.cookie,
      parsed.values.get('no-retry') !== true,
    );
    let posts: AuthoringPost[];
    try {
      posts = await listPosts(client, state as PostState, limit);
    } catch (error) {
      if (error instanceof AuthError) {
        env.stderr.write(`substackctl: ${error.message}\n`);
        return EXIT_AUTH;
      }
      throw error;
    }
    if (parsed.values.get('json') === true) {
      env.stdout.write(
        JSON.stringify(
          posts.map((post) => ({
            id: post.id,
            slug: post.slug,
            title: post.title,
            subtitle: post.subtitle,
            post_date: post.post_date,
            audience: post.audience,
            is_published: post.is_published,
            section: post.section,
            url: post.slug === null ? null : `${profile.publication}/p/${post.slug}`,
          })),
          null,
          2,
        ) + '\n',
      );
    } else {
      writeTable(env, posts);
    }
    return EXIT_SUCCESS;
  },
};

/**
 * Lists up to `limit` posts in `state`. The listing endpoints cap how much
 * one request may return, so larger limits are filled by paging; the state
 * filter for drafts runs client-side because /api/v1/drafts also returns
 * scheduled and published posts.
 */
async function listPosts(client: SubstackClient, state: PostState, limit: number): Promise<AuthoringPost[]> {
  if (state === 'draft') {
    const pageSize = Math.min(limit, DRAFTS_MAX_LIMIT);
    const posts: AuthoringPost[] = [];
    for (let offset = 0; posts.length < limit && offset < limit + DRAFTS_MAX_LIMIT; offset += pageSize) {
      const page = await client.listDrafts(pageSize, offset);
      const drafts = page.posts.filter((post) => !post.is_published && post.post_date === null);
      posts.push(...drafts);
      if (page.posts.length < pageSize) {
        break;
      }
    }
    return posts.slice(0, limit);
  }
  const pageSize = Math.min(limit, POST_MANAGEMENT_MAX_LIMIT);
  const posts: AuthoringPost[] = [];
  for (let offset = 0; posts.length < limit && offset < 200 * POST_MANAGEMENT_MAX_LIMIT; offset += pageSize) {
    const page = await client.listPostManagement(state, pageSize, offset);
    posts.push(...page.posts);
    if (posts.length >= page.total) {
      break;
    }
  }
  return posts.slice(0, limit);
}

function writeTable(env: Env, posts: AuthoringPost[]): void {
  if (posts.length === 0) {
    env.stdout.write('no posts found\n');
    return;
  }
  const header = ['POST_DATE', 'AUDIENCE', 'TITLE', 'ID'];
  const rows = posts.map((post) => [
    post.post_date === null ? '-' : post.post_date.slice(0, 10),
    post.audience ?? '-',
    post.title ?? '',
    String(post.id),
  ]);
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => row[column]!.length)),
  );
  const lines = [
    header.map((label, column) => label.padEnd(widths[column]!)).join('  ').trimEnd(),
    ...rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd()),
  ];
  env.stdout.write(lines.join('\n') + '\n');
}
