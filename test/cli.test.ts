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

test('--help prints commands and options on stdout and exits 0', async () => {
  const h = makeEnv();
  const code = await runCli(['--help'], h.env);
  assert.equal(code, 0);
  assert.match(h.stdout(), /usage: substackctl <command>/);
  assert.match(h.stdout(), /--version/);
  assert.equal(h.stderr(), '');
});

test('help prints the same top-level help on stdout', async () => {
  const h = makeEnv();
  const code = await runCli(['help'], h.env);
  assert.equal(code, 0);
  assert.match(h.stdout(), /usage: substackctl <command>/);
  assert.equal(h.stderr(), '');
});

test('help <command> prints the group usage and its subcommands', async () => {
  const h = makeEnv();
  const code = await runCli(['help', 'feed'], h.env);
  assert.equal(code, 0);
  assert.match(h.stdout(), /usage: substackctl feed/);
  assert.match(h.stdout(), /scan/);
  assert.equal(h.stderr(), '');
});

test('<command> help prints the group help', async () => {
  const h = makeEnv();
  const code = await runCli(['feed', 'help'], h.env);
  assert.equal(code, 0);
  assert.match(h.stdout(), /usage: substackctl feed/);
  assert.equal(h.stderr(), '');
});

test('<command> --help prints the group help', async () => {
  const h = makeEnv();
  const code = await runCli(['feed', '--help'], h.env);
  assert.equal(code, 0);
  assert.match(h.stdout(), /usage: substackctl feed/);
});

test('help with an unknown command exits 2', async () => {
  const h = makeEnv();
  const code = await runCli(['help', 'bogus'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /unknown command: bogus/);
  assert.equal(h.stdout(), '');
});

test('help with extra arguments exits 2', async () => {
  const h = makeEnv();
  const code = await runCli(['help', 'feed', 'scan'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /unexpected argument: scan/);
});

test('feed help with an extra argument exits 2', async () => {
  const h = makeEnv();
  const code = await runCli(['feed', 'help', 'scan'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /unexpected argument: scan/);
});

test('--version prints the package version on stdout and exits 0', async () => {
  const h = makeEnv();
  const code = await runCli(['--version'], h.env);
  assert.equal(code, 0);
  assert.match(h.stdout(), /^\d+\.\d+\.\d+\n$/);
  assert.equal(h.stderr(), '');
});

test('version prints the package version on stdout', async () => {
  const h = makeEnv();
  const code = await runCli(['version'], h.env);
  assert.equal(code, 0);
  assert.match(h.stdout(), /^\d+\.\d+\.\d+\n$/);
});

test('version with an extra argument exits 2', async () => {
  const h = makeEnv();
  const code = await runCli(['version', 'bogus'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /unexpected argument: bogus/);
});
