import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import { makeEnv } from './helpers.js';

test('no arguments prints usage on stderr and exits 2', async () => {
  const h = makeEnv();
  const code = await runCli([], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /usage: substackctl/);
  assert.equal(h.stdout(), '');
  assert.equal(h.requests.length, 0);
});

test('unknown command prints usage on stderr and exits 2', async () => {
  const h = makeEnv();
  const code = await runCli(['bogus'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /unknown command: bogus/);
  assert.match(h.stderr(), /usage: substackctl/);
});

test('feed without a subcommand exits 2', async () => {
  const h = makeEnv();
  const code = await runCli(['feed'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /usage: substackctl feed/);
});

test('feed with an unknown subcommand exits 2', async () => {
  const h = makeEnv();
  const code = await runCli(['feed', 'bogus'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /unknown subcommand: feed bogus/);
});
