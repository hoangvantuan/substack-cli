import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import type { FileSystem, HttpRequest, HttpResponse } from '../src/env/types.js';
import { EXIT_AUTH, EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE } from '../src/exit.js';
import { jsonResponse, makeEnv, type TestHarness } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CONFIG_PATH = '/home/tester/.config/sub-cli/config.json';
const CONFIG_DIR = '/home/tester/.config/sub-cli';
const PUBLICATION = 'https://tuanhvtest.substack.com';
const COOKIE = 'sid-value-123';
const DRAFTS_URL = `${PUBLICATION}/api/v1/drafts?limit=1&offset=0`;

/**
 * The profiles harness: the shared test environment with a fake filesystem,
 * a hidden-stdin queue, and a movable clock. Cookie reads must go through
 * readHidden, never through the echoing read.
 */
function makeProfileEnv(
  cookie: string = COOKIE,
  respond?: (request: HttpRequest) => HttpResponse,
): ProfileHarness {
  const h = makeEnv(respond);
  const files = new Map<string, { contents: string; mode?: number }>();
  const dirs: string[] = [];
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
    mkdir: async (path) => {
      dirs.push(path);
    },
    exists: async (path) => files.has(path),
  };
  const hiddenInputs = [cookie];
  const state = { hiddenReads: 0 };
  let now = 1_750_000_000_000;
  h.env.fs = fs;
  h.env.clock = () => now;
  h.env.stdin = {
    read: () => Promise.reject(new Error('cookie must be read without echoing')),
    readHidden: () => {
      state.hiddenReads += 1;
      return Promise.resolve(hiddenInputs.shift() ?? '');
    },
  };
  return {
    ...h,
    files,
    dirs,
    hiddenInputs,
    state,
    advance(ms: number): void {
      now += ms;
    },
    storedConfig(): Record<string, unknown> {
      return JSON.parse(files.get(CONFIG_PATH)!.contents) as Record<string, unknown>;
    },
  };
}

interface ProfileHarness extends TestHarness {
  files: Map<string, { contents: string; mode?: number }>;
  dirs: string[];
  hiddenInputs: string[];
  state: { hiddenReads: number };
  advance(ms: number): void;
  storedConfig(): Record<string, unknown>;
}

async function addProfile(h: ProfileHarness, name = 'testpub', publication = PUBLICATION): Promise<void> {
  const code = await runCli(['profile', 'add', name, publication], h.env);
  assert.equal(code, EXIT_SUCCESS, `add profile ${name} must succeed`);
}

test('profile add stores publication, cookie, and cookie set time', async () => {
  const h = makeProfileEnv();
  const code = await runCli(['profile', 'add', 'testpub', PUBLICATION], h.env);
  assert.equal(code, EXIT_SUCCESS);
  const config = h.storedConfig();
  assert.equal(config['schemaVersion'], 1);
  assert.equal(config['defaultProfile'], null);
  assert.deepEqual(config['profiles'], {
    testpub: { publication: PUBLICATION, cookie: COOKIE, cookieSetAt: 1_750_000_000_000 },
  });
  assert.equal(h.state.hiddenReads, 1);
});

test('the configuration file is created owner-readable only', async () => {
  const h = makeProfileEnv();
  await runCli(['profile', 'add', 'testpub', PUBLICATION], h.env);
  assert.equal(h.files.get(CONFIG_PATH)!.mode, 0o600);
  assert.deepEqual(h.dirs, [CONFIG_DIR]);
});

test('profile add normalises a slug publication to its base URL', async () => {
  const h = makeProfileEnv();
  const code = await runCli(['profile', 'add', 'testpub', 'tuanhvtest'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  const profiles = h.storedConfig()['profiles'] as Record<string, { publication: string }>;
  assert.equal(profiles['testpub']!.publication, PUBLICATION);
});

test('profile add honours XDG_CONFIG_HOME', async () => {
  const h = makeProfileEnv();
  h.env.vars['XDG_CONFIG_HOME'] = '/xdg-root';
  await runCli(['profile', 'add', 'testpub', PUBLICATION], h.env);
  assert.ok(h.files.has('/xdg-root/sub-cli/config.json'));
});

test('profile add on an existing name exits 2 without prompting again', async () => {
  const h = makeProfileEnv();
  await addProfile(h);
  h.hiddenInputs.push('other-cookie');
  const code = await runCli(['profile', 'add', 'testpub', PUBLICATION], h.env);
  assert.equal(code, EXIT_USAGE);
  assert.match(h.stderr(), /profile already exists: testpub/);
  assert.match(h.stderr(), /profile login testpub/);
  assert.equal(h.state.hiddenReads, 1);
  assert.equal((h.storedConfig()['profiles'] as Record<string, { cookie: string }>)['testpub']!.cookie, COOKIE);
});

test('profile add with a missing argument exits 2', async () => {
  const h = makeProfileEnv();
  assert.equal(await runCli(['profile', 'add', 'testpub'], h.env), EXIT_USAGE);
  assert.equal(await runCli(['profile', 'add'], h.env), EXIT_USAGE);
  assert.equal(h.files.size, 0);
});

test('profile add states its profile and publication on stderr before acting', async () => {
  const h = makeProfileEnv();
  await runCli(['profile', 'add', 'testpub', PUBLICATION], h.env);
  assert.match(h.stderr(), /adding profile testpub \(https:\/\/tuanhvtest\.substack\.com\)/);
});

test('profile add trims the pasted cookie, quotes, and the substack.sid prefix', async () => {
  const h = makeProfileEnv('  \n"substack.sid=abc-123"\n  ');
  await runCli(['profile', 'add', 'testpub', PUBLICATION], h.env);
  const profiles = h.storedConfig()['profiles'] as Record<string, { cookie: string }>;
  assert.equal(profiles['testpub']!.cookie, 'abc-123');
});

test('profile add with an empty cookie exits 1 and writes nothing', async () => {
  const h = makeProfileEnv('   \n');
  const code = await runCli(['profile', 'add', 'testpub', PUBLICATION], h.env);
  assert.equal(code, EXIT_FAILURE);
  assert.match(h.stderr(), /cookie must not be empty/);
  assert.equal(h.files.size, 0);
});

test('profile login refreshes the cookie without asking for the publication', async () => {
  const h = makeProfileEnv();
  await addProfile(h);
  h.hiddenInputs.push('new-cookie-456');
  h.advance(DAY_MS);
  const code = await runCli(['profile', 'login', 'testpub'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  const profiles = h.storedConfig()['profiles'] as Record<string, { cookie: string; cookieSetAt: number; publication: string }>;
  assert.equal(profiles['testpub']!.cookie, 'new-cookie-456');
  assert.equal(profiles['testpub']!.publication, PUBLICATION);
  assert.equal(profiles['testpub']!.cookieSetAt, 1_750_000_000_000 + DAY_MS);
  assert.match(h.stderr(), /refreshing the cookie for profile testpub/);
  assert.equal(h.state.hiddenReads, 2);
});

test('profile login on an unknown profile exits 2 and lists profiles', async () => {
  const h = makeProfileEnv();
  await addProfile(h);
  const code = await runCli(['profile', 'login', 'nope'], h.env);
  assert.equal(code, EXIT_USAGE);
  assert.match(h.stderr(), /unknown profile: nope/);
  assert.match(h.stderr(), /available profiles: testpub/);
});

test('profile list marks the default profile', async () => {
  const h = makeProfileEnv();
  await addProfile(h);
  h.hiddenInputs.push('other-cookie');
  await addProfile(h, 'other', 'https://other.substack.com');
  await runCli(['profile', 'use', 'testpub'], h.env);
  const code = await runCli(['profile', 'list'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  const lines = h.stdout().trimEnd().split('\n');
  assert.match(lines[0]!, /^DEFAULT\s+NAME\s+PUBLICATION$/);
  assert.match(lines[1]!, /^\*\s+testpub\s+https:\/\/tuanhvtest\.substack\.com$/);
  assert.match(lines[2]!, /^\s+other\s+https:\/\/other\.substack\.com$/);
});

test('profile list without profiles says so', async () => {
  const h = makeProfileEnv();
  const code = await runCli(['profile', 'list'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  assert.equal(h.stdout(), 'no profiles are configured\n');
});

test('profile use sets the default and states it on stderr', async () => {
  const h = makeProfileEnv();
  await addProfile(h);
  const code = await runCli(['profile', 'use', 'testpub'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  assert.equal(h.storedConfig()['defaultProfile'], 'testpub');
  assert.match(h.stderr(), /defaulting to profile testpub \(https:\/\/tuanhvtest\.substack\.com\)/);
});

test('profile use on an unknown profile exits 2', async () => {
  const h = makeProfileEnv();
  await addProfile(h);
  const code = await runCli(['profile', 'use', 'nope'], h.env);
  assert.equal(code, EXIT_USAGE);
  assert.match(h.stderr(), /unknown profile: nope/);
});

test('profile remove deletes the profile', async () => {
  const h = makeProfileEnv();
  await addProfile(h);
  const code = await runCli(['profile', 'remove', 'testpub'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  assert.deepEqual(h.storedConfig()['profiles'], {});
  assert.match(h.stderr(), /removing profile testpub/);
});

test('profile remove of the default leaves the default unset', async () => {
  const h = makeProfileEnv();
  await addProfile(h);
  await runCli(['profile', 'use', 'testpub'], h.env);
  const code = await runCli(['profile', 'remove', 'testpub'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  assert.equal(h.storedConfig()['defaultProfile'], null);
});

test('profile remove on an unknown profile exits 2', async () => {
  const h = makeProfileEnv();
  const code = await runCli(['profile', 'remove', 'nope'], h.env);
  assert.equal(code, EXIT_USAGE);
  assert.match(h.stderr(), /unknown profile: nope/);
});

test('profile check requests the drafts endpoint with the cookie', async () => {
  const h = makeProfileEnv();
  h.env.http = {
    request: async (request) => {
      h.requests.push(request);
      return jsonResponse([{ id: 1 }]);
    },
  };
  await addProfile(h);
  const code = await runCli(['profile', 'check'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.url, DRAFTS_URL);
  assert.equal(h.requests[0]!.headers?.['cookie'], `substack.sid=${COOKIE}`);
  assert.match(h.stdout(), /testpub \(https:\/\/tuanhvtest\.substack\.com\): cookie is valid/);
});

test('profile check exits 3 on 401', async () => {
  const h = makeProfileEnv(COOKIE, () => jsonResponse({}, 401));
  await addProfile(h);
  const code = await runCli(['profile', 'check'], h.env);
  assert.equal(code, EXIT_AUTH);
  assert.match(h.stderr(), /cookie is invalid or expired/);
  assert.equal(h.stdout(), '');
});

test('profile check exits 3 on 403', async () => {
  const h = makeProfileEnv(COOKIE, () => jsonResponse({}, 403));
  await addProfile(h);
  assert.equal(await runCli(['profile', 'check'], h.env), EXIT_AUTH);
});

test('profile check exits 1 on an unexpected status', async () => {
  const h = makeProfileEnv(COOKIE, () => jsonResponse({}, 500));
  await addProfile(h);
  const code = await runCli(['profile', 'check'], h.env);
  assert.equal(code, EXIT_FAILURE);
  assert.match(h.stderr(), /unexpected response \(HTTP 500\)/);
});

test('profile check with an explicit name uses that profile', async () => {
  const h = makeProfileEnv();
  await addProfile(h, 'first', PUBLICATION);
  h.hiddenInputs.push('second-cookie');
  await addProfile(h, 'second', 'https://second.substack.com');
  await runCli(['profile', 'use', 'first'], h.env);
  const code = await runCli(['profile', 'check', 'second'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  assert.equal(h.requests[0]!.url, 'https://second.substack.com/api/v1/drafts?limit=1&offset=0');
  assert.equal(h.requests[0]!.headers?.['cookie'], 'substack.sid=second-cookie');
});

test('profile check falls back to the default profile', async () => {
  const h = makeProfileEnv();
  await addProfile(h, 'first', PUBLICATION);
  h.hiddenInputs.push('second-cookie');
  await addProfile(h, 'second', 'https://second.substack.com');
  await runCli(['profile', 'use', 'second'], h.env);
  const code = await runCli(['profile', 'check'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  assert.equal(h.requests[0]!.url, 'https://second.substack.com/api/v1/drafts?limit=1&offset=0');
});

test('profile check uses the sole profile when no default is set', async () => {
  const h = makeProfileEnv();
  await addProfile(h);
  const code = await runCli(['profile', 'check'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  assert.equal(h.requests[0]!.url, DRAFTS_URL);
});

test('profile check with several profiles and no default exits 2 listing them', async () => {
  const h = makeProfileEnv();
  await addProfile(h, 'first', PUBLICATION);
  h.hiddenInputs.push('second-cookie');
  await addProfile(h, 'second', 'https://second.substack.com');
  const code = await runCli(['profile', 'check'], h.env);
  assert.equal(code, EXIT_USAGE);
  assert.match(h.stderr(), /no profile given and no default profile is set/);
  assert.match(h.stderr(), /available profiles: first, second/);
  assert.equal(h.requests.length, 0);
});

test('profile check with no profiles at all exits 2 with the add hint', async () => {
  const h = makeProfileEnv();
  const code = await runCli(['profile', 'check'], h.env);
  assert.equal(code, EXIT_USAGE);
  assert.match(h.stderr(), /no profiles are configured/);
  assert.match(h.stderr(), /profile add <name> <publication>/);
});

test('the environment variables override any stored profile', async () => {
  const h = makeProfileEnv();
  await addProfile(h);
  await runCli(['profile', 'use', 'testpub'], h.env);
  h.env.vars['SUBSTACK_PUBLICATION_URL'] = 'https://envpub.substack.com';
  h.env.vars['SUBSTACK_COOKIE'] = 'env-cookie-789';
  const code = await runCli(['profile', 'check'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  assert.equal(h.requests[0]!.url, 'https://envpub.substack.com/api/v1/drafts?limit=1&offset=0');
  assert.equal(h.requests[0]!.headers?.['cookie'], 'substack.sid=env-cookie-789');
  assert.match(h.stdout(), /environment \(https:\/\/envpub\.substack\.com\): cookie is valid/);
});

test('a pasted cookie in the environment variable is unwrapped before use', async () => {
  const h = makeProfileEnv();
  h.env.vars['SUBSTACK_PUBLICATION_URL'] = 'https://envpub.substack.com';
  h.env.vars['SUBSTACK_COOKIE'] = '"substack.sid=env-cookie-012" ';
  const code = await runCli(['profile', 'check'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  assert.equal(h.requests[0]!.headers?.['cookie'], 'substack.sid=env-cookie-012');
});

test('a stale cookie warns on stderr before the request is made', async () => {
  const h = makeProfileEnv();
  h.env.http = {
    request: async (request) => {
      h.requests.push(request);
      assert.match(h.stderr(), /warning: the cookie for testpub is 11 days old/);
      assert.match(h.stderr(), /profile login testpub/);
      return jsonResponse([]);
    },
  };
  await addProfile(h);
  h.advance(11 * DAY_MS);
  const code = await runCli(['profile', 'check'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  assert.equal(h.requests.length, 1);
});

test('a cookie exactly ten days old does not warn', async () => {
  const h = makeProfileEnv();
  await addProfile(h);
  h.advance(10 * DAY_MS);
  const code = await runCli(['profile', 'check'], h.env);
  assert.equal(code, EXIT_SUCCESS);
  assert.doesNotMatch(h.stderr(), /warning/);
});

test('a configuration file that is not valid JSON exits 1', async () => {
  const h = makeProfileEnv();
  h.files.set(CONFIG_PATH, { contents: '{oops' });
  const code = await runCli(['profile', 'list'], h.env);
  assert.equal(code, EXIT_FAILURE);
  assert.match(h.stderr(), /not valid JSON/);
});

test('a configuration file with an unsupported schema version exits 1', async () => {
  const h = makeProfileEnv();
  h.files.set(CONFIG_PATH, { contents: '{"schemaVersion":99,"defaultProfile":null,"profiles":{}}' });
  const code = await runCli(['profile', 'list'], h.env);
  assert.equal(code, EXIT_FAILURE);
  assert.match(h.stderr(), /unsupported configuration schema version 99/);
});

test('profile without a subcommand exits 2 and the group appears in the top usage', async () => {
  const h = makeProfileEnv();
  assert.equal(await runCli(['profile'], h.env), EXIT_USAGE);
  assert.match(h.stderr(), /usage: sub-cli profile/);
  await runCli([], h.env);
  assert.match(h.stderr(), /profile\s+manage named publication profiles/);
});
