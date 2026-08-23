import { requestWithRetry } from '../http/request.js';
import type { Env, HttpResponse } from '../env/types.js';

const POSTS_PATH = '/api/v1/posts';
export const ARCHIVE_PAGE_SIZE = 25;
export const DEFAULT_LIMIT = 10;

export interface PostSummary {
  id: number | null;
  slug: string;
  title: string | null;
  subtitle: string | null;
  post_date: string | null;
  audience: string | null;
  url: string | null;
  /** Full body HTML when the response includes it, else null. */
  body_html: string | null;
  /** Byline author names in publication order. */
  authors: string[];
}

/** Scans the recent feed, bounded to at most `limit` posts. */
export async function scanRecent(
  env: Env,
  base: string,
  limit: number,
  retry: boolean,
): Promise<PostSummary[]> {
  const url = `${base}${POSTS_PATH}?limit=${limit}&offset=0`;
  const page = parsePostsPage(await get(env, url, base, retry));
  return summarisePosts(page, base).slice(0, limit);
}

/** Scans the whole archive by walking the feed page by page. */
export async function scanArchive(env: Env, base: string, retry: boolean): Promise<PostSummary[]> {
  const collected: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += ARCHIVE_PAGE_SIZE) {
    const page = await fetchPostsPage(env, base, ARCHIVE_PAGE_SIZE, offset, retry);
    collected.push(...page);
    if (page.length < ARCHIVE_PAGE_SIZE) {
      break;
    }
  }
  return summarisePosts(collected, base);
}

/** Fetches one page of the public feed as raw post objects. */
export async function fetchPostsPage(
  env: Env,
  base: string,
  limit: number,
  offset: number,
  retry: boolean,
): Promise<Record<string, unknown>[]> {
  const url = `${base}${POSTS_PATH}?limit=${limit}&offset=${offset}`;
  return parsePostsPage(await get(env, url, base, retry));
}

async function get(env: Env, url: string, base: string, retry: boolean): Promise<HttpResponse> {
  const response = await requestWithRetry(env, { url }, { retry });
  if (response.status === 200) {
    return response;
  }
  if (response.status === 404) {
    throw new Error(`publication not found: ${base}`);
  }
  throw new Error(`${base} responded with status ${response.status}`);
}

function parsePostsPage(response: HttpResponse): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error('publication returned a body that is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('publication returned an unexpected response shape');
  }
  return parsed as Record<string, unknown>[];
}

/** Maps raw posts to summaries, newest first. */
export function summarisePosts(rawPosts: Record<string, unknown>[], base: string): PostSummary[] {
  return rawPosts
    .map((raw) => summarisePost(raw, base))
    .sort((a, b) => {
      const left = a.post_date ?? '';
      const right = b.post_date ?? '';
      return left < right ? 1 : left > right ? -1 : 0;
    });
}

/** Maps a single raw post object to its summary. */
export function summarisePost(raw: Record<string, unknown>, base: string): PostSummary {
  const slug = typeof raw['slug'] === 'string' ? raw['slug'] : '';
  const canonicalUrl = typeof raw['canonical_url'] === 'string' ? raw['canonical_url'] : null;
  const bylines = Array.isArray(raw['publishedBylines']) ? raw['publishedBylines'] : [];
  const authors: string[] = [];
  for (const byline of bylines) {
    if (typeof byline === 'object' && byline !== null) {
      const name = (byline as Record<string, unknown>)['name'];
      if (typeof name === 'string' && name !== '') {
        authors.push(name);
      }
    }
  }
  return {
    id: typeof raw['id'] === 'number' ? raw['id'] : null,
    slug,
    title: typeof raw['title'] === 'string' ? raw['title'] : null,
    subtitle: typeof raw['subtitle'] === 'string' ? raw['subtitle'] : null,
    post_date: typeof raw['post_date'] === 'string' ? raw['post_date'] : null,
    audience: typeof raw['audience'] === 'string' ? raw['audience'] : null,
    url: canonicalUrl ?? (slug === '' ? null : `${base}/p/${slug}`),
    body_html: typeof raw['body_html'] === 'string' ? raw['body_html'] : null,
    authors,
  };
}
