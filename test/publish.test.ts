import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import type { HttpRequest, HttpResponse } from '../src/env/types.js';
import { jsonResponse, makeEnv, type TestHarness } from './helpers.js';

/**
 * Tests for `post publish`. The refusal paths are exercised as carefully as
 * the success paths: ADR-0004 requires that without an explicit profile and
 * --yes the command refuses, names what is missing, and sends nothing.
 */
interface FileEnvOptions {
  files: Record<string, string>;
  vars?: Record<string, string>;
  configText?: string;
  route: (request: HttpRequest) => HttpResponse;
}

/** An environment serving post files and an optional profiles.json from disk, with routed HTTP responses. */
function envWithFiles(options: FileEnvOptions): TestHarness {
  const h = makeEnv();
  h.env.fs = {
    readFile: (path: string) => {
      if (path.endsWith('config.json')) {
        return Promise.resolve(options.configText ?? '{"schemaVersion":1,"defaultProfile":null,"profiles":{}}');
      }
      return path in options.files
        ? Promise.resolve(options.files[path]!)
        : Promise.reject(new Error('no such file'));
    },
    writeFile: () => Promise.reject(new Error('not used')),
    mkdir: () => Promise.reject(new Error('not used')),
    exists: (path: string) => Promise.resolve(path.endsWith('config.json') || path in options.files),
  };
  h.env.vars = options.vars ?? {};
  h.env.http = {
    request: async (request) => {
      h.requests.push(request);
      return options.route(request);
    },
  };
  return h;
}

/** A stored configuration document with the given named profiles and default. */
function storedConfig(
  profiles: Record<string, { publication: string; cookie: string }>,
  defaultProfile: string | null,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    defaultProfile,
    profiles: Object.fromEntries(
      Object.entries(profiles).map(([name, value]) => [name, { ...value, cookieSetAt: 0 }]),
    ),
  });
}

const ENV_PROFILE = {
  SUBSTACK_PUBLICATION_URL: 'https://envpub.substack.com',
  SUBSTACK_COOKIE: 'env-cookie',
};

const GOOD_POST = [
  '---',
  'title: Hello world',
  'subtitle: A first post',
  'audience: only_paid',
  '---',
  '',
  'A paragraph.',
].join('\n');

const DRAFT = { id: 777, slug: 'hello-world', draft_section_id: null };
const PUBLISHED = { ...DRAFT, is_published: true };

test('without any profile or confirmation it refuses naming both and sends nothing', async () => {
  const h = envWithFiles({
    files: { 'post.md': GOOD_POST },
    configText: storedConfig({}, null),
    route: () => jsonResponse({}),
  });
  const code = await runCli(['post', 'publish', 'post.md'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /refusing to publish/);
  assert.match(h.stderr(), /--profile <name>/);
  assert.match(h.stderr(), /--yes/);
  assert.equal(h.requests.length, 0);
});

test('a configured default profile is ignored: it still refuses without --profile', async () => {
  const h = envWithFiles({
    files: { 'post.md': GOOD_POST },
    configText: storedConfig({ main: { publication: 'https://stored.substack.com', cookie: 'stored-cookie' } }, 'main'),
    route: () => jsonResponse({}),
  });
  const code = await runCli(['post', 'publish', 'post.md', '--yes'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /refusing to publish/);
  assert.match(h.stderr(), /--profile <name>/);
  assert.equal(h.requests.length, 0);
});

test('the sole-profile shortcut is ignored when exactly one profile exists', async () => {
  const h = envWithFiles({
    files: { 'post.md': GOOD_POST },
    configText: storedConfig({ only: { publication: 'https://stored.substack.com', cookie: 'stored-cookie' } }, null),
    route: () => jsonResponse({}),
  });
  const code = await runCli(['post', 'publish', 'post.md', '--yes'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /refusing to publish/);
  assert.equal(h.requests.length, 0);
});

test('with a profile but without --yes it refuses naming --yes and sends nothing', async () => {
  const h = envWithFiles({ files: { 'post.md': GOOD_POST }, vars: ENV_PROFILE, route: () => jsonResponse({}) });
  const code = await runCli(['post', 'publish', 'post.md'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /refusing to publish/);
  assert.match(h.stderr(), /--yes/);
  assert.doesNotMatch(h.stderr(), /missing.*--profile|without --profile/);
  assert.equal(h.requests.length, 0);
});

test('an explicit profile name alone does not satisfy the confirmation either', async () => {
  // The refusal fires before the profile is looked up, so even an unknown
  // name must produce the --yes complaint, not "unknown profile".
  const h = envWithFiles({
    files: { 'post.md': GOOD_POST },
    configText: storedConfig({}, null),
    route: () => jsonResponse({}),
  });
  const code = await runCli(['post', 'publish', 'post.md', '--profile', 'named'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /--yes/);
  assert.equal(h.requests.length, 0);
});

test('passing both a file and --id is a usage error', async () => {
  const h = envWithFiles({ files: { 'post.md': GOOD_POST }, vars: ENV_PROFILE, route: () => jsonResponse({}) });
  const code = await runCli(['post', 'publish', 'post.md', '--id', '777', '--yes'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /exactly one source/);
  assert.equal(h.requests.length, 0);
});

test('passing neither a file nor --id is a usage error after the refusals pass', async () => {
  const h = envWithFiles({ files: {}, vars: ENV_PROFILE, route: () => jsonResponse({}) });
  const code = await runCli(['post', 'publish', '--yes'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /exactly one source/);
  assert.equal(h.requests.length, 0);
});

test('publishing a file creates and publishes in one command', async () => {
  const h = envWithFiles({
    files: { 'post.md': GOOD_POST },
    vars: ENV_PROFILE,
    route: (request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/publication/users')) {
        return jsonResponse([{ id: 5, role: 'admin', is_byline_only: false }]);
      }
      if (request.method === 'POST' && request.url.endsWith('/api/v1/drafts')) {
        return jsonResponse(DRAFT);
      }
      if (request.url.endsWith('/api/v1/drafts/777/prepublish')) {
        return jsonResponse({ errors: [], suggestions: [] });
      }
      return jsonResponse(PUBLISHED);
    },
  });
  const code = await runCli(['post', 'publish', 'post.md', '--yes'], h.env);
  assert.equal(code, 0);
  assert.deepEqual(
    h.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
    [
      'GET /api/v1/publication/users',
      'POST /api/v1/drafts',
      'PUT /api/v1/drafts/777',
      'GET /api/v1/drafts/777/prepublish',
      'POST /api/v1/drafts/777/publish',
    ],
  );
  const created = JSON.parse(h.requests[1]!.body!);
  assert.equal(created.audience, 'only_paid');
  assert.deepEqual(JSON.parse(h.requests[2]!.body!), { section_chosen: true });
  const published = JSON.parse(h.requests[4]!.body!);
  assert.deepEqual(published, { send: true, share_automatically: false });
  assert.match(h.stdout(), /published 777/);
  assert.match(h.stdout(), /url: https:\/\/envpub\.substack\.com\/p\/hello-world/);
});

test('--no-send publishes to the web without sending the email, and flags override front matter', async () => {
  const h = envWithFiles({
    files: { 'post.md': GOOD_POST },
    vars: ENV_PROFILE,
    route: (request) => {
      if (request.method === 'GET') {
        return request.url.endsWith('/prepublish')
          ? jsonResponse({ errors: [], suggestions: [] })
          : jsonResponse([{ id: 5, role: 'admin', is_byline_only: false }]);
      }
      if (request.method === 'POST' && request.url.endsWith('/api/v1/drafts')) {
        return jsonResponse(DRAFT);
      }
      return jsonResponse(PUBLISHED);
    },
  });
  const code = await runCli(['post', 'publish', 'post.md', '--yes', '--no-send', '--audience', 'everyone'], h.env);
  assert.equal(code, 0);
  const created = JSON.parse(h.requests[1]!.body!);
  assert.equal(created.audience, 'everyone');
  const published = JSON.parse(h.requests[4]!.body!);
  assert.deepEqual(published, { send: false, share_automatically: false });
});

test('a failing pre-publish check logs a warning and does not block publishing', async () => {
  const h = envWithFiles({
    files: { 'post.md': GOOD_POST },
    vars: ENV_PROFILE,
    route: (request) => {
      if (request.url.endsWith('/api/v1/publication/users')) {
        return jsonResponse([{ id: 5, role: 'admin', is_byline_only: false }]);
      }
      if (request.url.endsWith('/api/v1/drafts') && request.method === 'POST') {
        return jsonResponse(DRAFT);
      }
      if (request.url.endsWith('/prepublish')) {
        return jsonResponse({}, 500);
      }
      return jsonResponse(PUBLISHED);
    },
  });
  const code = await runCli(['post', 'publish', 'post.md', '--yes'], h.env);
  assert.equal(code, 0);
  assert.match(h.stderr(), /warning: pre-publish check failed/);
  assert.match(h.stderr(), /continuing/);
  assert.match(h.stdout(), /published 777/);
});

test('--id publishes an existing draft and --audience patches the draft first', async () => {
  const h = envWithFiles({
    files: {},
    vars: ENV_PROFILE,
    route: (request) => {
      if (request.method === 'PUT' && request.url.endsWith('/api/v1/drafts/777')) {
        return jsonResponse({ ...DRAFT, audience: 'only_free' });
      }
      if (request.url.endsWith('/prepublish')) {
        return jsonResponse({ errors: [], suggestions: [] });
      }
      if (request.method === 'POST' && request.url.endsWith('/publish')) {
        return jsonResponse(PUBLISHED);
      }
      return jsonResponse({ ...DRAFT, audience: 'everyone' });
    },
  });
  const code = await runCli(['post', 'publish', '--id', '777', '--yes', '--audience', 'only_free'], h.env);
  assert.equal(code, 0);
  assert.deepEqual(
    h.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
    ['GET /api/v1/drafts/777', 'PUT /api/v1/drafts/777', 'GET /api/v1/drafts/777/prepublish', 'POST /api/v1/drafts/777/publish'],
  );
  assert.deepEqual(JSON.parse(h.requests[1]!.body!), { section_chosen: true, audience: 'only_free' });
  assert.deepEqual(JSON.parse(h.requests[3]!.body!), { send: true, share_automatically: false });
  assert.match(h.stdout(), /published 777/);
});

test('--id without --audience leaves the stored recipient group untouched', async () => {
  const h = envWithFiles({
    files: {},
    vars: ENV_PROFILE,
    route: (request) => {
      if (request.url.endsWith('/prepublish')) {
        return jsonResponse({ errors: [], suggestions: [] });
      }
      if (request.method === 'POST' && request.url.endsWith('/publish')) {
        return jsonResponse(PUBLISHED);
      }
      return jsonResponse(DRAFT);
    },
  });
  const code = await runCli(['post', 'publish', '--id', '777', '--yes'], h.env);
  assert.equal(code, 0);
  // The publish-settings save still goes out; only the audience stays out of it.
  const patches = h.requests.filter((request) => request.method === 'PUT');
  assert.equal(patches.length, 1);
  assert.deepEqual(JSON.parse(patches[0]!.body!), { section_chosen: true });
});

test('a draft with a section but no publish-settings save is still published', async () => {
  // The real API answers 400 {"error":"Please choose a section."} for a draft
  // that carries draft_section_id but never had section_chosen saved, which is
  // exactly what `post create --section` leaves behind.
  const h = envWithFiles({
    files: {},
    vars: ENV_PROFILE,
    route: (request) => {
      if (request.method === 'POST' && request.url.endsWith('/publish')) {
        const saved = h.requests.some(
          (earlier) =>
            earlier.method === 'PUT' &&
            earlier.url.endsWith('/api/v1/drafts/777') &&
            JSON.parse(earlier.body!).section_chosen === true,
        );
        return saved
          ? jsonResponse(PUBLISHED)
          : jsonResponse({ error: 'Please choose a section.', type: 'single' }, 400);
      }
      if (request.url.endsWith('/prepublish')) {
        return jsonResponse({ errors: [], suggestions: [] });
      }
      return jsonResponse({ ...DRAFT, draft_section_id: 448651 });
    },
  });
  const code = await runCli(['post', 'publish', '--id', '777', '--yes'], h.env);
  assert.equal(code, 0);
  assert.match(h.stdout(), /published 777/);
});

test('publishing a nonexistent identifier fails before anything is sent', async () => {
  const h = envWithFiles({
    files: {},
    vars: ENV_PROFILE,
    route: (request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/drafts/999')) {
        return jsonResponse({}, 404);
      }
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    },
  });
  const code = await runCli(['post', 'publish', '--id', '999', '--yes'], h.env);
  assert.equal(code, 1);
  assert.ok(!h.requests.some((request) => request.url.endsWith('/publish')));
});

test('an invalid --audience is a usage error rejected before anything is sent', async () => {
  const h = envWithFiles({ files: { 'post.md': GOOD_POST }, vars: ENV_PROFILE, route: () => jsonResponse({}) });
  const code = await runCli(['post', 'publish', 'post.md', '--yes', '--audience', 'nobody'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /invalid audience "nobody"/);
  assert.equal(h.requests.length, 0);
});

test('an audience the file names badly is a run failure, not a usage error', async () => {
  const post = GOOD_POST.replace('audience: only_paid', 'audience: nobody');
  const h = envWithFiles({ files: { 'post.md': post }, vars: ENV_PROFILE, route: () => jsonResponse({}) });
  const code = await runCli(['post', 'publish', 'post.md', '--yes'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /invalid audience "nobody"/);
  assert.equal(h.requests.length, 0);
});

test('a draft created here is removed when publishing fails afterwards', async () => {
  const h = envWithFiles({
    files: { 'post.md': GOOD_POST },
    vars: ENV_PROFILE,
    route: (request) => {
      if (request.method === 'GET' && request.url.endsWith('/api/v1/publication/users')) {
        return jsonResponse([{ id: 5, role: 'admin', is_byline_only: false }]);
      }
      if (request.method === 'POST' && request.url.endsWith('/api/v1/drafts')) {
        return jsonResponse(DRAFT);
      }
      if (request.url.endsWith('/prepublish')) {
        return jsonResponse({ errors: [], suggestions: [] });
      }
      if (request.method === 'POST' && request.url.endsWith('/publish')) {
        return jsonResponse({ error: 'Please choose a section.', type: 'single' }, 400);
      }
      return jsonResponse(DRAFT);
    },
  });
  const code = await runCli(['post', 'publish', 'post.md', '--yes'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /Please choose a section/);
  const removal = h.requests.find((request) => request.method === 'DELETE');
  assert.equal(removal?.url, 'https://envpub.substack.com/api/v1/drafts/777');
});

test('a draft named by --id is never removed when publishing fails', async () => {
  const h = envWithFiles({
    files: {},
    vars: ENV_PROFILE,
    route: (request) => {
      if (request.url.endsWith('/prepublish')) {
        return jsonResponse({ errors: [], suggestions: [] });
      }
      if (request.method === 'POST' && request.url.endsWith('/publish')) {
        return jsonResponse({ error: 'Please choose a section.', type: 'single' }, 400);
      }
      return jsonResponse(DRAFT);
    },
  });
  const code = await runCli(['post', 'publish', '--id', '777', '--yes'], h.env);
  assert.equal(code, 1);
  assert.ok(!h.requests.some((request) => request.method === 'DELETE'));
});

test('slug, section, and cover front matter warn instead of being applied silently', async () => {
  const post = GOOD_POST.replace(
    'audience: only_paid',
    'audience: everyone\nslug: hello-world\ncover: https://example.com/c.png',
  );
  const h = envWithFiles({
    files: { 'post.md': post },
    vars: ENV_PROFILE,
    route: (request) => {
      if (request.method === 'GET') {
        return request.url.endsWith('/prepublish')
          ? jsonResponse({ errors: [], suggestions: [] })
          : jsonResponse([{ id: 5, role: 'admin', is_byline_only: false }]);
      }
      if (request.method === 'POST' && request.url.endsWith('/api/v1/drafts')) {
        return jsonResponse(DRAFT);
      }
      return jsonResponse(PUBLISHED);
    },
  });
  const code = await runCli(['post', 'publish', 'post.md', '--yes'], h.env);
  assert.equal(code, 0);
  assert.match(h.stderr(), /ignoring front matter field slug/);
  assert.match(h.stderr(), /ignoring front matter field cover/);
  const created = JSON.parse(h.requests[1]!.body!);
  assert.equal('cover_image' in created, false);
});
