import { requestWithRetry } from '../http/request.js';
import type { Env, HttpResponse } from '../env/types.js';

const POSTS_PATH = '/api/v1/posts';
const ARCHIVE_PAGE_SIZE = 25;
export const DEFAULT_LIMIT = 10;

export interface PostSummary {
  id: number | null;
  slug: string;
  title: string | null;
  subtitle: string | null;
  post_date: string | null;
  audience: string | null;
  url: string | null;
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
  return toSummaries(page, base).slice(0, limit);
}

/** Scans the whole archive by walking the feed page by page. */
export async function scanArchive(env: Env, base: string, retry: boolean): Promise<PostSummary[]> {
  const collected: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += ARCHIVE_PAGE_SIZE) {
    const url = `${base}${POSTS_PATH}?limit=${ARCHIVE_PAGE_SIZE}&offset=${offset}`;
    const page = parsePostsPage(await get(env, url, base, retry));
    collected.push(...page);
    if (page.length < ARCHIVE_PAGE_SIZE) {
      break;
    }
  }
  return toSummaries(collected, base);
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

function toSummaries(
  rawPosts: Record<string, unknown>[],
  base: string,
): PostSummary[] {
  return rawPosts
    .map((raw) => toPostSummary(raw, base))
    .sort((a, b) => {
      const left = a.post_date ?? '';
      const right = b.post_date ?? '';
      return left < right ? 1 : left > right ? -1 : 0;
    });
}

function toPostSummary(raw: Record<string, unknown>, base: string): PostSummary {
  const slug = typeof raw['slug'] === 'string' ? raw['slug'] : '';
  const canonicalUrl = typeof raw['canonical_url'] === 'string' ? raw['canonical_url'] : null;
  return {
    id: typeof raw['id'] === 'number' ? raw['id'] : null,
    slug,
    title: typeof raw['title'] === 'string' ? raw['title'] : null,
    subtitle: typeof raw['subtitle'] === 'string' ? raw['subtitle'] : null,
    post_date: typeof raw['post_date'] === 'string' ? raw['post_date'] : null,
    audience: typeof raw['audience'] === 'string' ? raw['audience'] : null,
    url: canonicalUrl ?? (slug === '' ? null : `${base}/p/${slug}`),
  };
}
