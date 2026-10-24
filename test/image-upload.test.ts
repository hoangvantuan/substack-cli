import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import type { HttpResponse } from '../src/env/types.js';
import { jsonResponse, makeEnv } from './helpers.js';

/**
 * Unit tests for `image upload`: local files go to the image endpoint and
 * their hosted URLs come back on stdout, one per line, ready for --cover.
 */

/** A minimal valid 1x1 red PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** An environment with in-memory files (base64 contents) and a canned image endpoint. */
function uploadEnv(files: Record<string, string>, respond?: (index: number) => HttpResponse) {
  let uploads = 0;
  const h = makeEnv((request) => {
    if (request.url.endsWith('/api/v1/image')) {
      uploads += 1;
      return respond?.(uploads) ?? jsonResponse({ id: uploads, url: `https://cdn.example/img${uploads}.png` });
    }
    return jsonResponse({}, 500);
  });
  h.env.fs = {
    readFile: () => Promise.reject(new Error('not used')),
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

test('a local image is uploaded and only its hosted URL is printed', async () => {
  const h = uploadEnv({ 'cover.png': PNG_BASE64 });
  const code = await runCli(['image', 'upload', './cover.png'], h.env);
  assert.equal(code, 0);
  assert.equal(h.requests.length, 1);
  const [upload] = h.requests;
  assert.equal(upload!.method, 'POST');
  assert.equal(upload!.url, 'https://envpub.substack.com/api/v1/image');
  assert.equal(upload!.headers?.['cookie'], 'substack.sid=env-cookie');
  assert.equal(upload!.body, `image=${encodeURIComponent(`data:image/png;base64,${PNG_BASE64}`)}`);
  assert.equal(h.stdout(), 'https://cdn.example/img1.png\n');
});

test('several files print one URL per line in argument order, paced between uploads', async () => {
  const h = uploadEnv({ 'a.png': PNG_BASE64, 'b.jpg': PNG_BASE64, 'c.webp': PNG_BASE64 });
  const code = await runCli(['image', 'upload', 'a.png', 'b.jpg', 'c.webp'], h.env);
  assert.equal(code, 0);
  assert.equal(
    h.stdout(),
    'https://cdn.example/img1.png\nhttps://cdn.example/img2.png\nhttps://cdn.example/img3.png\n',
  );
  assert.match(h.requests[1]!.body!, /^image=data%3Aimage%2Fjpeg%3Bbase64%2C/);
  assert.deepEqual(h.sleeps, [500, 500]);
});

test('a missing file stops the command before anything is uploaded', async () => {
  const h = uploadEnv({ 'a.png': PNG_BASE64 });
  const code = await runCli(['image', 'upload', 'a.png', 'missing.png'], h.env);
  assert.equal(code, 1);
  assert.equal(h.requests.length, 0);
  assert.match(h.stderr(), /image not found: missing\.png/);
  assert.equal(h.stdout(), '');
});

test('no file is a usage error', async () => {
  const h = uploadEnv({});
  const code = await runCli(['image', 'upload'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /missing <file>/);
  assert.match(h.stderr(), /usage: sub-cli image upload/);
});

test('a rejected cookie exits with the auth code', async () => {
  const h = uploadEnv({ 'a.png': PNG_BASE64 }, () => jsonResponse({}, 401));
  const code = await runCli(['image', 'upload', 'a.png'], h.env);
  assert.equal(code, 3);
  assert.match(h.stderr(), /profile login/);
  assert.equal(h.stdout(), '');
});

test('a local cover path is refused with a pointer to image upload', async () => {
  const h = uploadEnv({});
  h.env.fs.readFile = (path) =>
    path === 'post.md'
      ? Promise.resolve('---\ntitle: T\ncover: ./cover.png\n---\n\nBody\n')
      : Promise.reject(new Error('no such file'));
  const code = await runCli(['post', 'create', 'post.md', '--dry-run'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /sub-cli image upload <file>/);
});
