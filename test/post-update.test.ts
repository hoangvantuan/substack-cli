import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import type { HttpRequest, HttpResponse } from '../src/env/types.js';
import { jsonResponse, makeEnv, type TestHarness } from './helpers.js';

/**
 * Tests for `post update` (issue #14). The post state is read from the API
 * before any write: a published post is refused with a pointer to
 * `post revise` (ADR 0006), and `--file` replaces a draft's title and body.
 */

const HOSTED = 'https://substack-post-media.s3.amazonaws.com/public/images/probe.png';
const SECTIONS = [{ id: 7, name: 'News', slug: 'news' }];

type State = 'draft' | 'scheduled' | 'published';

function stateRecord(id: number, state: State): Record<string, unknown> {
  return {
    id,
    slug: 'current-slug',
    draft_section_id: null,
    draft_subtitle: 'Current subtitle',
    is_published: state === 'published',
    post_date: state === 'draft' ? null : '2026-10-01T09:00:00.000Z',
  };
}

/**
 * An environment holding in-memory files and routing every request the
 * update flow can issue. `afterPut` overrides the draft read that follows
 * the write, for verification failures.
 */
function updateEnv(options: {
  state: State;
  files?: Record<string, string>;
  afterPut?: Record<string, unknown>;
}): TestHarness {
  const files = options.files ?? {};
  let written = false;
  const h = makeEnv((request: HttpRequest): HttpResponse => {
    const path = new URL(request.url).pathname;
    if (path === '/api/v1/publication/sections') {
      return jsonResponse(SECTIONS);
    }
    if (path === '/api/v1/image') {
      return jsonResponse({ id: 42, url: HOSTED });
    }
    const draft = /^\/api\/v1\/drafts\/(\d+)$/.exec(path);
    if (draft !== null) {
      const id = Number(draft[1]);
      if (request.method === 'PUT') {
        written = true;
        return jsonResponse({ ...stateRecord(id, options.state), ...JSON.parse(request.body!) });
      }
      if (written) {
        return jsonResponse(options.afterPut ?? { ...stateRecord(id, options.state), draft_section_id: 7 });
      }
      return jsonResponse(stateRecord(id, options.state));
    }
    return jsonResponse({}, 500);
  });
  h.env.fs = {
    readFile: (path) =>
      path in files ? Promise.resolve(files[path]!) : Promise.reject(new Error(`no such file: ${path}`)),
    writeFile: () => Promise.reject(new Error('not used')),
    mkdir: () => Promise.reject(new Error('not used')),
    exists: (path) => Promise.resolve(path in files),
    readFileBase64: (path) =>
      path in files ? Promise.resolve(files[path]!) : Promise.reject(new Error(`no such file: ${path}`)),
  };
  h.env.vars = {
    SUBSTACK_PUBLICATION_URL: 'https://envpub.substack.com',
    SUBSTACK_COOKIE: 'env-cookie',
  };
  return h;
}

function puts(h: TestHarness): Record<string, unknown>[] {
  return h.requests.filter((request) => request.method === 'PUT').map((request) => JSON.parse(request.body!));
}

const NEW_POST = ['---', 'title: New title', '---', '', 'New **body**.'].join('\n');

test('post update refuses a published post, names post revise, and writes nothing', async () => {
  const h = updateEnv({ state: 'published' });
  const code = await runCli(['post', 'update', '55', '--subtitle', 'x'], h.env);
  assert.notEqual(code, 0);
  assert.match(h.stderr(), /post 55 is published/);
  assert.match(h.stderr(), /sub-cli post revise 55/);
  assert.equal(puts(h).length, 0);
  assert.doesNotMatch(h.stdout(), /updated/);
});

test('post update --file refuses a published post before uploading any image', async () => {
  const h = updateEnv({
    state: 'published',
    files: { 'post.md': NEW_POST + '\n\n![p](pic.png)\n', 'pic.png': 'AAAA' },
  });
  const code = await runCli(['post', 'update', '55', '--file', 'post.md'], h.env);
  assert.notEqual(code, 0);
  assert.match(h.stderr(), /sub-cli post revise 55/);
  assert.ok(!h.requests.some((request) => request.url.includes('/api/v1/image')));
  assert.equal(puts(h).length, 0);
});

test('post update --file replaces title and body and leaves unnamed fields alone', async () => {
  const h = updateEnv({ state: 'draft', files: { 'post.md': NEW_POST } });
  const code = await runCli(['post', 'update', '55', '--file', 'post.md'], h.env);
  assert.equal(code, 0, h.stderr());
  const [body] = puts(h);
  assert.deepEqual(Object.keys(body!).sort(), ['draft_body', 'draft_title']);
  assert.equal(body!['draft_title'], 'New title');
  const document = JSON.parse(body!['draft_body'] as string);
  assert.equal(document.type, 'doc');
  assert.match(JSON.stringify(document), /"text":"body"/);
  assert.match(h.stdout(), /^updated 55\n/);
});

test('post update --file works on a scheduled post', async () => {
  const h = updateEnv({ state: 'scheduled', files: { 'post.md': NEW_POST } });
  const code = await runCli(['post', 'update', '55', '--file', 'post.md'], h.env);
  assert.equal(code, 0, h.stderr());
  assert.equal(puts(h).length, 1);
});

test('front matter names subtitle, cover, section, slug; flags override it', async () => {
  const post = [
    '---',
    'title: New title',
    'subtitle: From file',
    'cover: https://example.com/cover.png',
    'section: News',
    'slug: from-file',
    '---',
    'Body.',
  ].join('\n');
  const h = updateEnv({ state: 'draft', files: { 'post.md': post } });
  const code = await runCli(['post', 'update', '55', '--file', 'post.md', '--slug', 'from-flag'], h.env);
  assert.equal(code, 0, h.stderr());
  const [body] = puts(h);
  assert.equal(body!['draft_subtitle'], 'From file');
  assert.equal(body!['cover_image'], 'https://example.com/cover.png');
  assert.equal(body!['draft_section_id'], 7);
  assert.equal(body!['slug'], 'from-flag');
  assert.equal(puts(h).length, 1, 'content and metadata ride one request');
});

test('post update --file uploads local images the same way post create does', async () => {
  const h = updateEnv({
    state: 'draft',
    files: { 'posts/post.md': NEW_POST + '\n\n![p](./pic.png)\n', 'posts/pic.png': 'AAAA' },
  });
  const code = await runCli(['post', 'update', '55', '--file', 'posts/post.md'], h.env);
  assert.equal(code, 0, h.stderr());
  const upload = h.requests.find((request) => request.url.includes('/api/v1/image'));
  assert.ok(upload !== undefined, 'no upload happened');
  const [body] = puts(h);
  assert.match(body!['draft_body'] as string, new RegExp(HOSTED.replace(/[./]/g, '\\$&')));
  assert.doesNotMatch(body!['draft_body'] as string, /pic\.png/);
});

test('post update --file without a title fails before any request', async () => {
  const h = updateEnv({ state: 'draft', files: { 'post.md': 'Only a body.' } });
  const code = await runCli(['post', 'update', '55', '--file', 'post.md'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /missing title/);
  assert.equal(h.requests.length, 0);
});

test('an audience in the front matter is ignored with a warning', async () => {
  const post = NEW_POST.replace('title: New title', 'title: New title\naudience: only_paid');
  const h = updateEnv({ state: 'draft', files: { 'post.md': post } });
  const code = await runCli(['post', 'update', '55', '--file', 'post.md'], h.env);
  assert.equal(code, 0, h.stderr());
  assert.match(h.stderr(), /ignoring front matter field "audience"/);
  assert.equal('audience' in puts(h)[0]!, false);
});

test('post update --dry-run reads the state, prints the request, and sends nothing else', async () => {
  const post = NEW_POST.replace('title: New title', 'title: New title\nsection: News');
  const h = updateEnv({ state: 'draft', files: { 'post.md': post + '\n\n![p](pic.png)\n', 'pic.png': 'AAAA' } });
  const code = await runCli(['post', 'update', '55', '--file', 'post.md', '--subtitle', 'S', '--dry-run'], h.env);
  assert.equal(code, 0, h.stderr());
  assert.deepEqual(
    h.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
    ['GET /api/v1/drafts/55'],
    'only the state read is sent',
  );
  const request = JSON.parse(h.stdout());
  assert.equal(request.method, 'PUT');
  assert.equal(request.url, '/api/v1/drafts/55');
  assert.equal(request.body.draft_title, 'New title');
  assert.equal(request.body.draft_subtitle, 'S');
  assert.equal(JSON.parse(request.body.draft_body).type, 'doc');
  assert.equal(request.section, 'News');
  assert.match(h.stderr(), /local image/);
});

test('post update --dry-run on a published post refuses like the real run', async () => {
  const h = updateEnv({ state: 'published', files: { 'post.md': NEW_POST } });
  const code = await runCli(['post', 'update', '55', '--file', 'post.md', '--dry-run'], h.env);
  assert.notEqual(code, 0);
  assert.match(h.stderr(), /sub-cli post revise 55/);
  assert.equal(h.stdout(), '');
});

test('post update with metadata flags only keeps the one-request behaviour', async () => {
  const h = updateEnv({ state: 'draft' });
  const code = await runCli(
    ['post', 'update', '55', '--subtitle', 'S', '--slug', 'new-slug', '--section', 'News', '--cover', 'https://example.com/c.png'],
    h.env,
  );
  assert.equal(code, 0, h.stderr());
  assert.deepEqual(puts(h), [
    { draft_subtitle: 'S', slug: 'new-slug', cover_image: 'https://example.com/c.png', draft_section_id: 7 },
  ]);
  assert.match(h.stdout(), /url: https:\/\/envpub\.substack\.com\/p\/new-slug/);
});

test('post update with nothing to change is a usage error', async () => {
  const h = updateEnv({ state: 'draft' });
  const code = await runCli(['post', 'update', '55'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /nothing to update/);
  assert.equal(h.requests.length, 0);
});

test('post update fails when the section does not stick', async () => {
  const h = updateEnv({ state: 'draft', afterPut: { ...stateRecord(55, 'draft'), draft_section_id: null } });
  const code = await runCli(['post', 'update', '55', '--section', 'News'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /did not stick/);
});
