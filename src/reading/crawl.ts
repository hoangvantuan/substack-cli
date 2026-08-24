import { parseArgv } from '../args.js';
import type { Subcommand } from '../commands.js';
import type { Env } from '../env/types.js';
import { EXIT_SUCCESS, UsageError } from '../exit.js';
import { requestWithRetry } from '../http/request.js';
import { htmlToMarkdown } from './crawl-markdown.js';
import {
  ARCHIVE_PAGE_SIZE,
  DEFAULT_LIMIT,
  fetchPostsPage,
  scanRecent,
  summarisePost,
  summarisePosts,
  type PostSummary,
} from './feed.js';
import { publicationBaseUrl } from './publication.js';

/** Pause between HTTP requests while batch crawling. */
export const CRAWL_PACE_MS = 500;

export const crawlUsage =
  'usage: sub-cli feed crawl <url> [--out <dir>] [--overwrite] [--no-retry]';

export const crawlAllUsage =
  'usage: sub-cli feed crawl-all <publication> [--limit <n>] [--all] [--out <dir>] [--overwrite] [--no-retry]';

export const crawlCommand: Subcommand = {
  name: 'crawl',
  description: 'crawl a public post to a Markdown file without authentication',
  usage: crawlUsage,
  async run(argv, env) {
    const parsed = parseArgv(argv, { strings: ['out'], booleans: ['overwrite', 'no-retry'] });
    const url = parsed.positionals[0];
    if (url === undefined) {
      throw new UsageError('missing <url>');
    }
    if (parsed.positionals.length > 1) {
      throw new UsageError(`unexpected argument: ${parsed.positionals[1]}`);
    }
    const slug = postSlugFromUrl(url);
    const base = publicationBaseUrl(url);
    const retry = parsed.values.get('no-retry') !== true;
    const raw = await fetchPost(env, base, slug, retry, url);
    await writeCrawledPost(env, outDirOf(parsed), summarisePost(raw, base), base, overwriteOf(parsed));
    return EXIT_SUCCESS;
  },
};

export const crawlAllCommand: Subcommand = {
  name: 'crawl-all',
  description: 'crawl every post of a public feed to Markdown files',
  usage: crawlAllUsage,
  async run(argv, env) {
    const parsed = parseArgv(argv, {
      strings: ['limit', 'out'],
      booleans: ['all', 'overwrite', 'no-retry'],
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
      ? await crawlArchiveWithPacing(env, base, retry)
      : await scanRecent(env, base, limit ?? DEFAULT_LIMIT, retry);
    if (posts.length === 0) {
      env.stderr.write('sub-cli: no posts found\n');
      return EXIT_SUCCESS;
    }
    for (const post of posts) {
      await writeCrawledPost(env, outDirOf(parsed), post, base, overwriteOf(parsed));
    }
    return EXIT_SUCCESS;
  },
};

/** Walks the whole archive, pausing between page requests. */
async function crawlArchiveWithPacing(env: Env, base: string, retry: boolean): Promise<PostSummary[]> {
  const collected: Record<string, unknown>[] = [];
  let first = true;
  for (let offset = 0; ; offset += ARCHIVE_PAGE_SIZE) {
    if (!first) {
      await env.sleep(CRAWL_PACE_MS);
    }
    first = false;
    const page = await fetchPostsPage(env, base, ARCHIVE_PAGE_SIZE, offset, retry);
    collected.push(...page);
    if (page.length < ARCHIVE_PAGE_SIZE) {
      break;
    }
  }
  return summarisePosts(collected, base);
}

/** Fetches one public post by slug; the id form of this endpoint 404s. */
async function fetchPost(
  env: Env,
  base: string,
  slug: string,
  retry: boolean,
  displayUrl: string,
): Promise<Record<string, unknown>> {
  const response = await requestWithRetry(env, { url: `${base}/api/v1/posts/${slug}` }, { retry });
  if (response.status === 404) {
    throw new Error(`post not found: ${displayUrl}`);
  }
  if (response.status !== 200) {
    throw new Error(`${base} responded with status ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error('publication returned a body that is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('publication returned an unexpected response shape');
  }
  return parsed as Record<string, unknown>;
}

function postSlugFromUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UsageError(`invalid post URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`invalid post URL: ${input}`);
  }
  const match = /^\/p\/([^/]+)\/?$/.exec(url.pathname);
  if (match === null) {
    throw new UsageError(`not a post URL (expected https://example.substack.com/p/slug): ${input}`);
  }
  return match[1]!;
}

interface CrawledFile {
  dir: string;
  fileName: string;
  contents: string;
}

function buildCrawledFile(post: PostSummary, base: string): CrawledFile {
  const hostname = new URL(base).hostname;
  const publication = hostname.endsWith('.substack.com')
    ? hostname.slice(0, -'.substack.com'.length)
    : hostname;
  const rawDate = post.post_date;
  const dated = rawDate !== null && /^\d{4}-\d{2}-\d{2}/.test(rawDate);
  const date = dated ? rawDate.slice(0, 10) : 'undated';
  const slug = post.slug === '' ? 'untitled' : post.slug.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const front = [
    '---',
    `title: ${yamlScalar(post.title)}`,
    `subtitle: ${yamlScalar(post.subtitle)}`,
    `author: ${yamlScalar(post.authors.join(', '))}`,
    `date: ${yamlScalar(dated ? date : null)}`,
    `source_url: ${yamlScalar(post.url)}`,
    `publication: ${yamlScalar(publication)}`,
    '---',
  ].join('\n');
  const markdown = htmlToMarkdown(post.body_html ?? '', { baseUrl: base });
  const contents = markdown === '' ? `${front}\n` : `${front}\n\n${markdown}\n`;
  return { dir: publication, fileName: `${date}-${slug}.md`, contents };
}

async function writeCrawledPost(
  env: Env,
  outDir: string,
  post: PostSummary,
  base: string,
  overwrite: boolean,
): Promise<void> {
  const file = buildCrawledFile(post, base);
  const path = joinOut(outDir, `${file.dir}/${file.fileName}`);
  if (!overwrite && (await env.fs.exists(path))) {
    env.stderr.write(`sub-cli: skipped ${path} (already crawled)\n`);
    return;
  }
  await env.fs.mkdir(joinOut(outDir, file.dir));
  await env.fs.writeFile(path, file.contents);
  if ((post.body_html ?? '').trim() === '') {
    env.stderr.write(`sub-cli: ${path}: no body in the post; wrote front matter only\n`);
  }
  env.stderr.write(`sub-cli: wrote ${path}\n`);
}

/** JSON string escaping is a valid YAML double-quoted scalar. */
function yamlScalar(value: string | null): string {
  return JSON.stringify(value ?? '');
}

function joinOut(outDir: string, rest: string): string {
  return outDir === '.' || outDir === '' ? rest : `${outDir}/${rest}`;
}

function outDirOf(parsed: { values: Map<string, string | boolean> }): string {
  const out = parsed.values.get('out');
  if (typeof out !== 'string' || out === '') return '.';
  return out.replace(/\/+$/, '') || '.';
}

function overwriteOf(parsed: { values: Map<string, string | boolean> }): boolean {
  return parsed.values.get('overwrite') === true;
}
