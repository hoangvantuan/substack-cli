import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, runCliWithUpdateNotice } from '../src/cli.js';
import type { ExecResult, FileSystem, HttpRequest, HttpResponse } from '../src/env/types.js';
import { EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE } from '../src/exit.js';
import { cliVersion } from '../src/version.js';
import { compareVersions } from '../src/update/check.js';
import { runUpdate } from '../src/update/update.js';
import { jsonResponse, makeEnv, type TestHarness } from './helpers.js';

const REGISTRY_URL = 'https://registry.npmjs.org/substackctl/latest';
const CHECK_PATH = '/home/tester/.config/substackctl/update-check.json';
const HOUR_MS = 60 * 60 * 1000;

const NPM_GLOBAL_URL = 'file:///usr/local/lib/node_modules/substackctl/dist/src/update/update.js';
const NPX_CACHE_URL = 'file:///home/tester/.npm/_npx/a1b2c3/node_modules/substackctl/dist/src/update/update.js';
const CHECKOUT_URL = 'file:///repo/substack-cli/dist/src/update/update.js';

interface UpdateHarness extends TestHarness {
  files: Map<string, { contents: string; mode?: number }>;
  advance(ms: number): void;
  setExecResult(result: ExecResult): void;
  registryRequests(): number;
}

/**
 * The update harness: a fake filesystem for the check cache, a movable
 * clock for the daily interval, and a switchable child-command result.
 * `profile list` serves as the carrier command: it runs for real, needs no
 * network of its own, and belongs to a command group.
 */
function makeUpdateEnv(
  respond?: (request: HttpRequest) => HttpResponse,
): UpdateHarness {
  const h = makeEnv(respond === undefined ? undefined : (request) => respond(request));
  delete h.env.vars['SUBSTACKCTL_NO_UPDATE_CHECK'];
  const files = new Map<string, { contents: string; mode?: number }>();
  const fs: FileSystem = {
    readFile: async (path) => {
      const file = files.get(path);
      if (file === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return file.contents;
    },
    writeFile: async (path, contents, options) => {
      files.set(path, { contents, mode: options?.mode });
    },
    mkdir: async () => {},
    exists: async (path) => files.has(path),
  };
  h.env.fs = fs;
  let now = 1_750_000_000_000;
  h.env.clock = () => now;
  let execResult: ExecResult = { code: 0, stdout: '', stderr: '' };
  h.env.exec = {
    run: async (command, args) => {
      h.execs.push({ command, args: [...args] });
      return execResult;
    },
  };
  return {
    ...h,
    files,
    advance(ms: number): void {
      now += ms;
    },
    setExecResult(result: ExecResult): void {
      execResult = result;
    },
    registryRequests(): number {
      return h.requests.filter((request) => request.url === REGISTRY_URL).length;
    },
  };
}

function registry(version: string): (request: HttpRequest) => HttpResponse {
  return (request) => (request.url === REGISTRY_URL ? jsonResponse({ version }) : jsonResponse({}, 404));
}

test('compareVersions orders by major, minor, patch and rejects junk', () => {
  assert.equal(compareVersions('0.2.0', '0.2.1'), -1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  let threw = false;
  try {
    compareVersions('x', '0.2.0');
  } catch {
    threw = true;
  }
  assert.ok(threw);
});

test('update reports up to date, refreshes the cache, and runs nothing', async () => {
  const h = makeUpdateEnv(registry(cliVersion()));
  const code = await runUpdate([], h.env, NPM_GLOBAL_URL);
  assert.equal(code, EXIT_SUCCESS);
  assert.match(h.stdout(), /is up to date/);
  assert.equal(h.execs.length, 0);
  assert.deepEqual(JSON.parse(h.files.get(CHECK_PATH)!.contents), {
    checkedAt: 1_750_000_000_000,
    latest: cliVersion(),
  });
});

test('update installs the newer release over npm when npm-managed', async () => {
  const h = makeUpdateEnv(registry('9.9.9'));
  const code = await runUpdate([], h.env, NPM_GLOBAL_URL);
  assert.equal(code, EXIT_SUCCESS);
  assert.deepEqual(h.execs, [{ command: 'npm', args: ['install', '-g', 'substackctl@9.9.9'] }]);
  assert.match(h.stdout(), /updated to 9\.9\.9/);
  assert.deepEqual(JSON.parse(h.files.get(CHECK_PATH)!.contents), {
    checkedAt: 1_750_000_000_000,
    latest: '9.9.9',
  });
});

test('update surfaces npm failures and the manual command', async () => {
  const h = makeUpdateEnv(registry('9.9.9'));
  h.setExecResult({ code: 1, stdout: '', stderr: 'npm ERR! oh no\n' });
  const code = await runUpdate([], h.env, NPM_GLOBAL_URL);
  assert.equal(code, EXIT_FAILURE);
  assert.match(h.stderr(), /npm ERR! oh no/);
  assert.match(h.stderr(), /run manually: npm install -g substackctl@9\.9\.9/);
  assert.doesNotMatch(h.stdout(), /updated to/);
  assert.equal(h.files.has(CHECK_PATH), false);
});

test('update without an npm install prints the manual command and installs nothing', async () => {
  for (const moduleUrl of [CHECKOUT_URL, NPX_CACHE_URL]) {
    const h = makeUpdateEnv(registry('9.9.9'));
    const code = await runUpdate([], h.env, moduleUrl);
    assert.equal(code, EXIT_FAILURE);
    assert.match(h.stdout(), /npm install -g substackctl@9\.9\.9/);
    assert.equal(h.execs.length, 0);
  }
});

test('update rejects arguments and options as usage errors', async () => {
  const h = makeUpdateEnv(registry('9.9.9'));
  assert.equal(await runUpdate(['bogus'], h.env), EXIT_USAGE);
  assert.equal(await runUpdate(['--json'], h.env), EXIT_USAGE);
  assert.match(h.stderr(), /unexpected argument: bogus/);
  assert.match(h.stderr(), /unknown option/);
  assert.equal(h.execs.length, 0);
});

test('update exits 1 when the registry is unreachable', async () => {
  const h = makeUpdateEnv(() => jsonResponse({}, 500));
  const code = await runCli(['update'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /npm registry returned HTTP 500/);
});

test('a real command warns on stderr when a newer release exists', async () => {
  const h = makeUpdateEnv(registry('9.9.9'));
  const code = await runCliWithUpdateNotice(['profile', 'list'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  assert.equal(h.stdout(), 'no profiles are configured\n');
  assert.match(h.stderr(), /substackctl 9\.9\.9 is available; run "substackctl update" to upgrade/);
  assert.equal(h.registryRequests(), 1);
});

test('the warning repeats from cache without a second registry request', async () => {
  const h = makeUpdateEnv(registry('9.9.9'));
  await runCliWithUpdateNotice(['profile', 'list'], h.env);
  h.advance(HOUR_MS);
  await runCliWithUpdateNotice(['profile', 'list'], h.env);
  assert.equal(h.registryRequests(), 1);
  assert.match(h.stderr(), /9\.9\.9 is available/);
});

test('a stale cache triggers one new registry request per day', async () => {
  const h = makeUpdateEnv(registry('9.9.9'));
  await runCliWithUpdateNotice(['profile', 'list'], h.env);
  h.advance(25 * HOUR_MS);
  await runCliWithUpdateNotice(['profile', 'list'], h.env);
  assert.equal(h.registryRequests(), 2);
});

test('no warning when the release is current, and the cache is still written', async () => {
  const h = makeUpdateEnv(registry(cliVersion()));
  const code = await runCliWithUpdateNotice(['profile', 'list'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  assert.equal(h.stderr(), '');
  assert.deepEqual(JSON.parse(h.files.get(CHECK_PATH)!.contents), {
    checkedAt: 1_750_000_000_000,
    latest: cliVersion(),
  });
});
test('a failed check is cached so an offline machine stays quiet for a day', async () => {
  const h = makeUpdateEnv((request) =>
    request.url === REGISTRY_URL ? jsonResponse({}, 500) : jsonResponse({}),
  );
  await runCliWithUpdateNotice(['profile', 'list'], h.env);
  assert.equal(h.stderr(), '');
  h.advance(HOUR_MS);
  await runCliWithUpdateNotice(['profile', 'list'], h.env);
  assert.equal(h.registryRequests(), 1);
});

test('SUBSTACKCTL_NO_UPDATE_CHECK skips the check entirely', async () => {
  const h = makeUpdateEnv(registry('9.9.9'));
  h.env.vars['SUBSTACKCTL_NO_UPDATE_CHECK'] = '1';
  const code = await runCliWithUpdateNotice(['profile', 'list'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  assert.equal(h.stderr(), '');
  assert.equal(h.registryRequests(), 0);
});

test('help, version, update, and unknown commands never trigger the warning', async () => {
  const h = makeUpdateEnv(registry('9.9.9'));
  await runCliWithUpdateNotice(['--version'], h.env);
  await runCliWithUpdateNotice(['help'], h.env);
  // `update` itself queries the registry once; the warning path must not
  // add a second request after it.
  await runCliWithUpdateNotice(['update'], h.env);
  await runCliWithUpdateNotice(['bogus'], h.env);
  assert.equal(h.registryRequests(), 1);
  assert.doesNotMatch(h.stderr(), /is available/);
});
