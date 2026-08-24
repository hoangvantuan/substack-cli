import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import type { HttpResponse } from '../src/env/types.js';
import { jsonResponse, makeEnv } from './helpers.js';

/**
 * Drives `post list` with a canned response per request in order and the
 * environment variables standing in for a stored profile.
 */
function listEnv(responses: HttpResponse[], vars: Record<string, string | undefined> = {}) {
  const h = makeEnv();
  let index = 0;
  h.env.http = {
    request: async (request) => {
      h.requests.push(request);
      const response = responses[index] ?? jsonResponse({}, 500);
      index += 1;
      return response;
    },
  };
  h.env.vars = {
    SUBSTACK_PUBLICATION_URL: 'https://envpub.substack.com',
    SUBSTACK_COOKIE: 'env-cookie',
    ...vars,
  };
  h.env.fs = {
    readFile: () => Promise.reject(new Error('not used')),
    writeFile: () => Promise.reject(new Error('not used')),
    mkdir: () => Promise.reject(new Error('not used')),
    exists: () => Promise.resolve(false),
  };
  return h;
}

function draftEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 11,
    draft_title: 'First draft',
    slug: null,
    post_date: null,
    is_published: false,
    audience: 'everyone',
    draft_updated_at: '2026-08-20T09:00:00Z',
    ...overrides,
  };
}

test('post list defaults to drafts from post_management and prints a table', async () => {
  const h = listEnv([jsonResponse({ posts: [draftEntry()], total: 1 })]);
  const code = await runCli(['post', 'list'], h.env);
  assert.equal(code, 0);
  assert.equal(h.requests.length, 1);
  // /api/v1/drafts ignores `offset` and cannot be paged, so the draft state
  // reads the same listing the other two states do.
  assert.equal(
    h.requests[0]!.url,
    'https://envpub.substack.com/api/v1/post_management/drafts?offset=0&limit=10&order_by=draft_updated_at&order_direction=desc',
  );
  assert.equal(h.requests[0]!.headers?.['cookie'], 'substack.sid=env-cookie');
  const lines = h.stdout().split('\n');
  assert.match(lines[0]!, /^POST_DATE {2}AUDIENCE {2}TITLE/);
  assert.match(lines[1]!, /^- {10}everyone {2}First draft {2}11$/);
});

test('the draft listing is taken as the endpoint states it, without client-side filtering', async () => {
  // post_management/drafts answers drafts only, so every row it names is one.
  const h = listEnv([
    jsonResponse({
      posts: [draftEntry({ id: 11, draft_title: 'Pure draft' }), draftEntry({ id: 12, draft_title: 'Another draft' })],
      total: 2,
    }),
  ]);
  const code = await runCli(['post', 'list', '--state', 'draft'], h.env);
  assert.equal(code, 0);
  const titles = h.stdout().split('\n').slice(1).join('\n');
  assert.match(titles, /Pure draft/);
  assert.match(titles, /Another draft/);
  assert.equal(h.requests.length, 1);
});

test('a draft listing shorter than the limit stops instead of re-reading the first page', async () => {
  // The regression this guards: paging /api/v1/drafts returned the same page
  // for every offset, so `--limit 20` printed three drafts four times over.
  const h = listEnv([
    jsonResponse({
      posts: [draftEntry({ id: 11 }), draftEntry({ id: 12 }), draftEntry({ id: 13 })],
      total: 3,
    }),
  ]);
  const code = await runCli(['post', 'list', '--state', 'draft', '--limit', '20'], h.env);
  assert.equal(code, 0);
  assert.equal(h.requests.length, 1);
  const ids = h.stdout().split('\n').slice(1).filter((line) => line !== '').map((line) => line.trim().split(/ +/).pop());
  assert.deepEqual(ids, ['11', '12', '13']);
});

test('post list --state scheduled uses post_management with its required ordering', async () => {
  const h = listEnv([
    jsonResponse({
      posts: [{ id: 21, title: 'Soon', slug: 'soon', post_date: '2026-09-01T09:00:00Z', audience: 'only_paid', is_published: false }],
      total: 1,
      limit: 10,
      offset: 0,
    }),
  ]);
  const code = await runCli(['post', 'list', '--state', 'scheduled'], h.env);
  assert.equal(code, 0);
  assert.equal(
    h.requests[0]!.url,
    'https://envpub.substack.com/api/v1/post_management/scheduled?offset=0&limit=10&order_by=draft_updated_at&order_direction=desc',
  );
  assert.match(h.stdout(), /2026-09-01 {2}only_paid {2}Soon {3}21/);
});

test('post list --state published and --json together', async () => {
  const h = listEnv([
    jsonResponse({
      posts: [{ id: 31, title: 'Live', slug: 'live', post_date: '2026-08-01T09:00:00Z', audience: 'everyone', is_published: true, draft_section_name: 'News' }],
      total: 1,
    }),
  ]);
  const code = await runCli(['post', 'list', '--state', 'published', '--json'], h.env);
  assert.equal(code, 0);
  const posts = JSON.parse(h.stdout());
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, 31);
  assert.equal(posts[0].title, 'Live');
  assert.equal(posts[0].section, 'News');
  assert.equal(posts[0].url, 'https://envpub.substack.com/p/live');
});

test('a draft limit above the endpoint maximum pages by total', async () => {
  let calls = 0;
  const h = listEnv([]);
  h.env.http = {
    request: async (request) => {
      h.requests.push(request);
      calls += 1;
      // Three full pages of 50, then a short page: 170 drafts in total.
      const count = calls <= 3 ? 50 : 20;
      const posts = Array.from({ length: count }, (_, i) => draftEntry({ id: 1000 + calls * 100 + i }));
      return jsonResponse({ posts, total: 170 });
    },
  };
  const code = await runCli(['post', 'list', '--limit', '150'], h.env);
  assert.equal(code, 0);
  assert.deepEqual(
    h.requests.map((request) => new URL(request.url).search),
    [
      '?offset=0&limit=50&order_by=draft_updated_at&order_direction=desc',
      '?offset=50&limit=50&order_by=draft_updated_at&order_direction=desc',
      '?offset=100&limit=50&order_by=draft_updated_at&order_direction=desc',
    ],
  );
  const rows = h.stdout().split('\n').filter((line) => line.includes('First draft'));
  assert.equal(rows.length, 150);
});

test('a limit above the post_management maximum pages by total', async () => {
  let calls = 0;
  const h = listEnv([]);
  h.env.http = {
    request: async (request) => {
      h.requests.push(request);
      calls += 1;
      const count = calls <= 2 ? 50 : 20;
      const posts = Array.from({ length: count }, (_, i) => ({ id: 2000 + calls * 100 + i, title: `Post ${i}` }));
      return jsonResponse({ posts, total: 120 });
    },
  };
  const code = await runCli(['post', 'list', '--state', 'published', '--limit', '120'], h.env);
  assert.equal(code, 0);
  assert.deepEqual(
    h.requests.map((request) => request.url),
    [
      'https://envpub.substack.com/api/v1/post_management/published?offset=0&limit=50&order_by=draft_updated_at&order_direction=desc',
      'https://envpub.substack.com/api/v1/post_management/published?offset=50&limit=50&order_by=draft_updated_at&order_direction=desc',
      'https://envpub.substack.com/api/v1/post_management/published?offset=100&limit=50&order_by=draft_updated_at&order_direction=desc',
    ],
  );
});

test('an empty listing says so', async () => {
  const h = listEnv([jsonResponse({ posts: [], hasMore: false })]);
  const code = await runCli(['post', 'list'], h.env);
  assert.equal(code, 0);
  assert.equal(h.stdout(), 'no posts found\n');
});

test('an invalid state is a usage error', async () => {
  const h = listEnv([]);
  const code = await runCli(['post', 'list', '--state', 'archived'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /invalid state "archived"/);
  assert.equal(h.requests.length, 0);
});

test('an invalid limit is a usage error', async () => {
  const h = listEnv([]);
  const code = await runCli(['post', 'list', '--limit', '0'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /--limit must be a positive integer/);
});

test('a rejected cookie exits 3', async () => {
  const h = listEnv([jsonResponse({ errors: [] }, 403)]);
  const code = await runCli(['post', 'list'], h.env);
  assert.equal(code, 3);
  assert.match(h.stderr(), /cookie/);
});
