import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import type { HttpRequest, HttpResponse } from '../src/env/types.js';
import { jsonResponse, makeEnv } from './helpers.js';

/**
 * Unit tests for issue #8: local body images are uploaded and rewritten to
 * hosted URLs before the draft is created, covers ride outside the body, and
 * everything runs on substituted filesystems and HTTP so no network exists.
 */

/** A minimal valid 1x1 red PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const HOSTED = 'https://substack-post-media.s3.amazonaws.com/public/images/probe_1x1.png';

function postWith(body: string): string {
  return ['---', 'title: Image probe', '---', '', body].join('\n');
}

/**
 * An environment with in-memory files (base64 contents) and one canned
 * authoring flow: publication users, image uploads, draft create, draft read.
 */
function imageEnv(files: Record<string, string>, extraDrafts: HttpResponse[] = []) {
  const h = makeEnv((request) => {
    if (request.url.includes('/api/v1/publication/users')) {
      return jsonResponse([{ id: 7, role: 'admin', is_byline_only: false }]);
    }
    if (request.url.includes('/api/v1/image')) {
      return jsonResponse({ id: 42, url: HOSTED, contentType: 'image/png' });
    }
    if (request.url.endsWith('/api/v1/drafts') && request.method === 'POST') {
      return jsonResponse({ id: 5, slug: null, draft_section_id: null });
    }
    if (/\/api\/v1\/drafts\/\d+$/.test(request.url)) {
      const [first] = extraDrafts.splice(0, 1);
      return first ?? jsonResponse({ id: 5, slug: null, draft_section_id: null });
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

function draftsRequestBody(requests: HttpRequest[]): Record<string, unknown> {
  const create = requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/v1/drafts'));
  assert.ok(create !== undefined, 'the flow never created a draft');
  return JSON.parse(create.body!);
}

test('a local body image is uploaded and its src rewritten to the hosted URL', async () => {
  const h = imageEnv({
    'posts/post.md': postWith('Before\n\n![probe](./pic.png)\n'),
    'posts/pic.png': PNG_BASE64,
  });
  const code = await runCli(['post', 'create', 'posts/post.md'], h.env);
  assert.equal(code, 0);
  const upload = h.requests.find((r) => r.url.includes('/api/v1/image'));
  assert.ok(upload !== undefined, 'no upload happened');
  assert.equal(upload.method, 'POST');
  assert.match(upload.body!, /^image=data%3Aimage%2Fpng%3Bbase64%2C/);
  const body = draftsRequestBody(h.requests);
  const document = JSON.parse(body.draft_body as string);
  const image = document.content.find((n: { type: string }) => n.type === 'captionedImage');
  assert.equal(image.content[0].attrs.src, HOSTED);
  assert.doesNotMatch(body.draft_body as string, /pic\.png/);
});

test('an http(s) reference is left untouched and uploads nothing', async () => {
  const remote = 'https://example.com/remote.png';
  const h = imageEnv({ 'post.md': postWith(`![remote](${remote})\n`) });
  await runCli(['post', 'create', 'post.md'], h.env);
  assert.equal(h.requests.filter((r) => r.url.includes('/api/v1/image')).length, 0);
  const body = draftsRequestBody(h.requests);
  assert.match(body.draft_body as string, new RegExp(remote.replace(/\./g, '\\.')));
});

test('a missing local image file stops with a clear error before any draft exists', async () => {
  const h = imageEnv({ 'post.md': postWith('![gone](./missing.png)\n') });
  const code = await runCli(['post', 'create', 'post.md'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /local image not found: .*missing\.png/);
  // The byline lookup may run, but no upload and no draft ever happen.
  assert.equal(h.requests.filter((r) => r.url.includes('/api/v1/image')).length, 0);
  assert.equal(h.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/api/v1/drafts')).length, 0);
});


test('consecutive uploads pace themselves through env.sleep', async () => {
  const files: Record<string, string> = { 'post.md': undefined! };
  files['post.md'] = postWith('![a](./a.png)\n\n![b](./b.png)\n');
  files['a.png'] = PNG_BASE64;
  files['b.png'] = PNG_BASE64;
  const h = imageEnv(files);
  let uploads = 0;
  const originalRequest = h.env.http.request;
  h.env.http.request = async (request) => {
    if (request.url.includes('/api/v1/image')) {
      uploads += 1;
    }
    return originalRequest(request);
  };
  await runCli(['post', 'create', 'post.md'], h.env);
  assert.equal(uploads, 2);
  assert.deepEqual(h.sleeps, [500]);
});

test('one upload needs no pacing sleep', async () => {
  const h = imageEnv({
    'post.md': postWith('![a](./a.png)\n'),
    'a.png': PNG_BASE64,
  });
  await runCli(['post', 'create', 'post.md'], h.env);
  assert.deepEqual(h.sleeps, []);
});

test('the same local file referenced twice is uploaded once', async () => {
  const h = imageEnv({
    'post.md': postWith('![a](./a.png)\n\n![again](./a.png)\n'),
    'a.png': PNG_BASE64,
  });
  await runCli(['post', 'create', 'post.md'], h.env);
  assert.equal(h.requests.filter((r) => r.url.includes('/api/v1/image')).length, 1);
  const body = draftsRequestBody(h.requests);
  assert.equal((body.draft_body as string).split(HOSTED).length - 1, 2);
});

test('--dry-run keeps the local src and warns that sending will upload it', async () => {
  const h = imageEnv({ 'post.md': postWith('![probe](./pic.png)\n') });
  const code = await runCli(['post', 'create', 'post.md', '--dry-run'], h.env);
  assert.equal(code, 0);
  assert.equal(h.requests.length, 0);
  assert.match(h.stderr(), /local image.*will be uploaded when the post is sent/);
  const request = JSON.parse(h.stdout());
  const document = JSON.parse(request.body.draft_body as string);
  assert.equal(document.content[0].content[0].attrs.src, './pic.png');
});

test('a cover rides only in cover_image, never inside the body', async () => {
  const cover = 'https://example.com/cover.png';
  const h = imageEnv({
    'post.md': postWith('Body text.\n').replace('title: Image probe', `title: Image probe\ncover: ${cover}`),
  });
  await runCli(['post', 'create', 'post.md'], h.env);
  const body = draftsRequestBody(h.requests);
  assert.equal(body.cover_image, cover);
  assert.doesNotMatch(body.draft_body as string, /cover\.png/);
});

test('a post without a cover creates normally with no cover_image field', async () => {
  const h = imageEnv({ 'post.md': postWith('Body text.\n') });
  const code = await runCli(['post', 'create', 'post.md'], h.env);
  assert.equal(code, 0);
  const body = draftsRequestBody(h.requests);
  assert.equal(body.cover_image, undefined);
});
