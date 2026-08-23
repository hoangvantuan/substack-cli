import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import { jsonResponse, makeEnv, postFixture } from './helpers.js';

test('--limit bounds the requested feed', async () => {
  const h = makeEnv(() => jsonResponse([]));
  const code = await runCli(['feed', 'scan', 'onestacks', '--limit', '3'], h.env);
  assert.equal(code, 0);
  assert.equal(h.requests[0]?.url, 'https://onestacks.substack.com/api/v1/posts?limit=3&offset=0');
});

test('--limit=N inline form works', async () => {
  const h = makeEnv(() => jsonResponse([]));
  await runCli(['feed', 'scan', 'onestacks', '--limit=4'], h.env);
  assert.equal(h.requests[0]?.url, 'https://onestacks.substack.com/api/v1/posts?limit=4&offset=0');
});

test('--limit truncates the returned feed to the bound', async () => {
  const h = makeEnv(() => jsonResponse([postFixture({ id: 1 }), postFixture({ id: 2 }), postFixture({ id: 3 })]));
  const code = await runCli(['feed', 'scan', 'onestacks', '--limit', '2', '--json'], h.env);
  assert.equal(code, 0);
  const rows = JSON.parse(h.stdout()) as unknown[];
  assert.equal(rows.length, 2);
});

test('--limit without a value is a usage error', async () => {
  const h = makeEnv();
  const code = await runCli(['feed', 'scan', 'onestacks', '--limit'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /--limit requires a value/);
});

test('--limit with a non-integer value is a usage error', async () => {
  const h = makeEnv();
  const code = await runCli(['feed', 'scan', 'onestacks', '--limit', 'abc'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /--limit must be a positive integer/);
});

test('--limit with a value below one is a usage error', async () => {
  const h = makeEnv();
  const code = await runCli(['feed', 'scan', 'onestacks', '--limit', '0'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /--limit must be a positive integer/);
});

test('--limit cannot be combined with --all', async () => {
  const h = makeEnv();
  const code = await runCli(['feed', 'scan', 'onestacks', '--all', '--limit', '5'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /--limit cannot be combined with --all/);
});

test('an unknown option is a usage error', async () => {
  const h = makeEnv();
  const code = await runCli(['feed', 'scan', 'onestacks', '--frobnicate'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /unknown option --frobnicate/);
});

test('a missing publication is a usage error', async () => {
  const h = makeEnv();
  const code = await runCli(['feed', 'scan'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /missing <publication>/);
  assert.match(h.stderr(), /usage: substackctl feed scan/);
});

test('an extra positional is a usage error', async () => {
  const h = makeEnv();
  const code = await runCli(['feed', 'scan', 'onestacks', 'extra'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /unexpected argument: extra/);
});

test('an unparseable publication is a usage error', async () => {
  const h = makeEnv();
  const code = await runCli(['feed', 'scan', 'not a url at all'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /invalid publication/);
});

function archivePage(count: number, startId: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) =>
    postFixture({ id: startId + i, slug: `post-${startId + i}`, title: `Post ${startId + i}` }),
  );
}

test('--all walks every page of the archive', async () => {
  const h = makeEnv((_request, index) => {
    if (index === 0) return jsonResponse(archivePage(25, 1));
    if (index === 1) return jsonResponse(archivePage(25, 26));
    return jsonResponse(archivePage(3, 51));
  });
  const code = await runCli(['feed', 'scan', 'onestacks', '--all', '--json'], h.env);
  assert.equal(code, 0);
  assert.deepEqual(
    h.requests.map((request) => request.url),
    [
      'https://onestacks.substack.com/api/v1/posts?limit=25&offset=0',
      'https://onestacks.substack.com/api/v1/posts?limit=25&offset=25',
      'https://onestacks.substack.com/api/v1/posts?limit=25&offset=50',
    ],
  );
  const rows = JSON.parse(h.stdout()) as unknown[];
  assert.equal(rows.length, 53);
});

test('--all stops on an empty page', async () => {
  const h = makeEnv((_request, index) => {
    if (index === 0) return jsonResponse(archivePage(25, 1));
    return jsonResponse([]);
  });
  const code = await runCli(['feed', 'scan', 'onestacks', '--all', '--json'], h.env);
  assert.equal(code, 0);
  assert.equal(h.requests.length, 2);
  const rows = JSON.parse(h.stdout()) as unknown[];
  assert.equal(rows.length, 25);
});

test('a missing publication URL exits 1 with a not-found message', async () => {
  const h = makeEnv(() => jsonResponse({}, 404));
  const code = await runCli(['feed', 'scan', 'ghost-publication'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /publication not found: https:\/\/ghost-publication\.substack\.com/);
});

test('a server error exits 1', async () => {
  const h = makeEnv(() => jsonResponse({}, 500));
  const code = await runCli(['feed', 'scan', 'onestacks'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /responded with status 500/);
});

test('a body that is not JSON exits 1', async () => {
  const h = makeEnv(() => ({ status: 200, headers: {}, body: '<html>not json</html>' }));
  const code = await runCli(['feed', 'scan', 'onestacks'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /not valid JSON/);
});

test('a transport failure exits 1', async () => {
  const h = makeEnv(() => {
    throw new Error('network down');
  });
  const code = await runCli(['feed', 'scan', 'onestacks'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /network down/);
});
