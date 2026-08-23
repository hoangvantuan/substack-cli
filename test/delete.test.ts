import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import type { HttpResponse } from '../src/env/types.js';
import { jsonResponse, makeEnv } from './helpers.js';

function envWithFiles(files: Record<string, string>) {
  const h = makeEnv();
  h.env.fs = {
    readFile: (path: string) =>
      path in files ? Promise.resolve(files[path]!) : Promise.reject(new Error('no such file')),
    writeFile: () => Promise.reject(new Error('not used')),
    mkdir: () => Promise.reject(new Error('not used')),
    exists: (path: string) => Promise.resolve(path in files),
  };
  return h;
}

/**
 * A deleting environment: the two environment variables standing in for a
 * stored profile, and one canned response per request in order.
 */
function deleteEnv(responses: HttpResponse[], args: string[] = []) {
  const h = envWithFiles({});
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
    ...Object.fromEntries(args.map((entry) => [entry, undefined])),
  };
  return h;
}

const draftState = { id: 11, slug: null, draft_section_id: null, is_published: false, post_date: null };

test('a draft is deleted after --yes, with the state read from the API first', async () => {
  const h = deleteEnv([
    jsonResponse({ ...draftState }),
    jsonResponse({}),
  ]);
  const code = await runCli(['post', 'delete', '11', '--yes'], h.env);
  assert.equal(code, 0);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0]!.method, 'GET');
  assert.equal(h.requests[0]!.url, 'https://envpub.substack.com/api/v1/drafts/11');
  assert.equal(h.requests[1]!.method, 'DELETE');
  assert.equal(h.requests[1]!.url, 'https://envpub.substack.com/api/v1/drafts/11');
  assert.equal(h.stdout(), 'deleted 11\n');
});

test('a scheduled post is deleted like a draft', async () => {
  const h = deleteEnv([
    jsonResponse({ ...draftState, post_date: '2027-01-01T00:00:00Z' }),
    jsonResponse({}),
  ]);
  const code = await runCli(['post', 'delete', '11', '--yes'], h.env);
  assert.equal(code, 0);
  assert.equal(h.requests.length, 2);
  assert.equal(h.stdout(), 'deleted 11\n');
});

test('a published post is refused even with --yes, and nothing is deleted', async () => {
  const h = deleteEnv([
    jsonResponse({ id: 12, is_published: true, post_date: '2026-08-01T00:00:00Z' }),
  ]);
  const code = await runCli(['post', 'delete', '12', '--yes'], h.env);
  assert.equal(code, 1);
  assert.equal(h.requests.length, 1, 'only the state check may run');
  assert.match(h.stderr(), /published/);
  assert.match(h.stderr(), /--force-published/);
});

test('a published post is only deleted with the separate --force-published flag', async () => {
  const h = deleteEnv([
    jsonResponse({ id: 12, is_published: true, post_date: '2026-08-01T00:00:00Z' }),
    jsonResponse({}),
  ]);
  const code = await runCli(['post', 'delete', '12', '--yes', '--force-published'], h.env);
  assert.equal(code, 0);
  assert.equal(h.requests.length, 2);
  assert.equal(h.stdout(), 'deleted 12\n');
  assert.match(h.stderr(), /cannot be undone|deleting post 12/);
});

test('missing --yes refuses with a usage error and sends nothing', async () => {
  const h = deleteEnv([]);
  const code = await runCli(['post', 'delete', '11'], h.env);
  assert.equal(code, 2);
  assert.equal(h.requests.length, 0);
  assert.match(h.stderr(), /--yes/);
});

test('the state check comes before any deletion regardless of flags', async () => {
  // Even with both flags the API is consulted first: a draft that turned out
  // to be published is refused without the extra flag.
  const h = deleteEnv([
    jsonResponse({ id: 13, is_published: true, post_date: '2026-08-01T00:00:00Z' }),
  ], []);
  const code = await runCli(['post', 'delete', '13', '--yes'], h.env);
  assert.equal(code, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.stdout(), '');
});

test('a rejected cookie exits 3', async () => {
  const h = deleteEnv([jsonResponse({ errors: [] }, 401)]);
  const code = await runCli(['post', 'delete', '11', '--yes'], h.env);
  assert.equal(code, 3);
  assert.match(h.stderr(), /cookie.*profile login/s);
});

test('a non-integer id is a usage error', async () => {
  const h = deleteEnv([]);
  const code = await runCli(['post', 'delete', 'abc', '--yes'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /positive integer/);
});
