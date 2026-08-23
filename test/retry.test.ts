import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import { jsonResponse, makeEnv, postFixture } from './helpers.js';

function rateLimited(headers: Record<string, string> = {}): {
  status: number;
  headers: Record<string, string>;
  body: string;
} {
  return { status: 429, headers, body: '' };
}

test('a rate-limited request is retried honouring Retry-After', async () => {
  const h = makeEnv((_request, index) =>
    index === 0 ? rateLimited({ 'retry-after': '2' }) : jsonResponse([postFixture()]),
  );
  const code = await runCli(['feed', 'scan', 'onestacks', '--json'], h.env);
  assert.equal(code, 0);
  assert.deepEqual(h.sleeps, [2000]);
  assert.match(h.stderr(), /rate limited; retry 1 of 4 after 2000ms/);
  const rows = JSON.parse(h.stdout()) as unknown[];
  assert.equal(rows.length, 1);
});

test('a rate-limited request is retried honouring an HTTP-date Retry-After', async () => {
  const until = 'Tue, 01 Jan 2030 00:00:00 GMT';
  const h = makeEnv((_request, index) =>
    index === 0 ? rateLimited({ 'Retry-After': until }) : jsonResponse([]),
  );
  const code = await runCli(['feed', 'scan', 'onestacks'], h.env);
  assert.equal(code, 0);
  const expected = Math.max(0, Date.parse(until) - 1_750_000_000_000);
  assert.deepEqual(h.sleeps, [expected]);
});

test('without Retry-After the fixed ladder is used', async () => {
  const h = makeEnv((_request, index) =>
    index < 2 ? rateLimited() : jsonResponse([postFixture()]),
  );
  const code = await runCli(['feed', 'scan', 'onestacks'], h.env);
  assert.equal(code, 0);
  assert.deepEqual(h.sleeps, [1000, 2000]);
  assert.equal(h.requests.length, 3);
});

test('exhausted retries exit 4 after the whole ladder', async () => {
  const h = makeEnv(() => rateLimited());
  const code = await runCli(['feed', 'scan', 'onestacks'], h.env);
  assert.equal(code, 4);
  assert.equal(h.requests.length, 5);
  assert.deepEqual(h.sleeps, [1000, 2000, 4000, 8000]);
  assert.match(h.stderr(), /rate limited; giving up after 5 attempts/);
  assert.equal(h.stdout(), '');
});

test('--no-retry fails fast with exit 4 and no sleeps', async () => {
  const h = makeEnv(() => rateLimited());
  const code = await runCli(['feed', 'scan', 'onestacks', '--no-retry'], h.env);
  assert.equal(code, 4);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.sleeps, []);
  assert.match(h.stderr(), /rate limited; giving up after 1 attempt/);
});
