import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import { jsonResponse, makeEnv, postFixture } from './helpers.js';

const FEED_URL = 'https://onestacks.substack.com/api/v1/posts?limit=10&offset=0';

test('scan with a slug requests the publication feed and exits 0', async () => {
  const h = makeEnv(() => jsonResponse([postFixture()]));
  const code = await runCli(['feed', 'scan', 'onestacks'], h.env);
  assert.equal(code, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]?.url, FEED_URL);
  assert.equal(h.stderr(), '');
});

test('scan with a full URL scans that publication', async () => {
  const h = makeEnv(() => jsonResponse([postFixture()]));
  await runCli(['feed', 'scan', 'https://onestacks.substack.com'], h.env);
  assert.equal(h.requests[0]?.url, FEED_URL);
});

test('scan with a bare domain scans that publication', async () => {
  const h = makeEnv(() => jsonResponse([postFixture()]));
  await runCli(['feed', 'scan', 'onestacks.substack.com'], h.env);
  assert.equal(h.requests[0]?.url, FEED_URL);
});

test('scan with a custom-domain URL scans that domain', async () => {
  const h = makeEnv(() => jsonResponse([]));
  await runCli(['feed', 'scan', 'https://blog.example.com'], h.env);
  assert.equal(h.requests[0]?.url, 'https://blog.example.com/api/v1/posts?limit=10&offset=0');
});

test('scan drops any path from the given URL', async () => {
  const h = makeEnv(() => jsonResponse([]));
  await runCli(['feed', 'scan', 'https://onestacks.substack.com/p/some-post'], h.env);
  assert.equal(h.requests[0]?.url, FEED_URL);
});

test('scan upgrades an http URL to https', async () => {
  const h = makeEnv(() => jsonResponse([]));
  await runCli(['feed', 'scan', 'http://onestacks.substack.com'], h.env);
  assert.equal(h.requests[0]?.url, FEED_URL);
});

test('default output is a table of date, audience, and title', async () => {
  const h = makeEnv(() =>
    jsonResponse([
      postFixture(),
      postFixture({
        id: 2,
        slug: 'second',
        title: 'A much longer second title',
        post_date: '2026-07-15T18:30:00Z',
        audience: 'only_paid',
      }),
    ]),
  );
  const code = await runCli(['feed', 'scan', 'onestacks'], h.env);
  assert.equal(code, 0);
  const lines = h.stdout().split('\n');
  assert.match(lines[0] ?? '', /POST_DATE\s+AUDIENCE\s+TITLE/);
  assert.match(h.stdout(), /2026-08-01\s+everyone\s+Hello world/);
  assert.match(h.stdout(), /2026-07-15\s+only_paid\s+A much longer second title/);
  assert.equal(h.stderr(), '');
});

test('--json emits a structured array with post metadata', async () => {
  const h = makeEnv(() => jsonResponse([postFixture({ subtitle: null })]));
  const code = await runCli(['feed', 'scan', 'onestacks', '--json'], h.env);
  assert.equal(code, 0);
  const rows = JSON.parse(h.stdout()) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.['id'], 1);
  assert.equal(rows[0]?.['slug'], 'hello-world');
  assert.equal(rows[0]?.['title'], 'Hello world');
  assert.equal(rows[0]?.['subtitle'], null);
  assert.equal(rows[0]?.['post_date'], '2026-08-01T09:00:00Z');
  assert.equal(rows[0]?.['audience'], 'everyone');
  assert.equal(rows[0]?.['url'], 'https://onestacks.substack.com/p/hello-world');
  assert.equal(h.stderr(), '');
});

test('an empty feed prints no posts found', async () => {
  const h = makeEnv(() => jsonResponse([]));
  const code = await runCli(['feed', 'scan', 'onestacks'], h.env);
  assert.equal(code, 0);
  assert.match(h.stdout(), /no posts found/);
});

test('a canonical_url from the feed is preferred over the constructed URL', async () => {
  const h = makeEnv(() =>
    jsonResponse([postFixture({ canonical_url: 'https://custom.example.com/p/hello-world' })]),
  );
  const code = await runCli(['feed', 'scan', 'onestacks', '--json'], h.env);
  assert.equal(code, 0);
  const rows = JSON.parse(h.stdout()) as Array<Record<string, unknown>>;
  assert.equal(rows[0]?.['url'], 'https://custom.example.com/p/hello-world');
});
