import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import { makeEnv } from './helpers.js';

function envWithFiles(files: Record<string, string>) {
  const h = makeEnv();
  h.env.fs = {
    readFile: (path: string) =>
      path in files ? Promise.resolve(files[path]!) : Promise.reject(new Error('no such file')),
    writeFile: () => Promise.reject(new Error('not used')),
    mkdir: () => Promise.reject(new Error('not used')),
    exists: (path: string) => Promise.resolve(path in files),
  };
  return h;
}

const GOOD_POST = [
  '---',
  'title: Hello world',
  'subtitle: A first post',
  'audience: only_paid',
  'slug: hello-world',
  '---',
  '# Heading',
  '',
  'Body with **bold** and [a link](https://example.com).',
].join('\n');

test('post create --dry-run exits 0, prints the request, and sends nothing', async () => {
  const h = envWithFiles({ 'post.md': GOOD_POST });
  const code = await runCli(['post', 'create', 'post.md', '--dry-run'], h.env);
  assert.equal(code, 0);
  assert.equal(h.requests.length, 0);
  const request = JSON.parse(h.stdout());
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/drafts');
  assert.equal(request.body.draft_title, 'Hello world');
  assert.equal(request.body.draft_subtitle, 'A first post');
  assert.equal(request.body.audience, 'only_paid');
  assert.equal(request.body.type, 'newsletter');
  assert.deepEqual(request.body.draft_bylines, [{ id: null, is_guest: false }]);
  const document = JSON.parse(request.body.draft_body as string);
  assert.equal(document.type, 'doc');
  assert.deepEqual(document.content[0], {
    type: 'heading',
    attrs: { level: 2 },
    content: [{ type: 'text', text: 'Heading' }],
  });
  assert.deepEqual(request.after_create, { slug: 'hello-world' });
});

test('cover and section from front matter reach the printed request', async () => {
  const post = GOOD_POST.replace(
    'slug: hello-world',
    'slug: hello-world\ncover: https://example.com/cover.png\nsection: Newsletters',
  );
  const h = envWithFiles({ 'post.md': post });
  await runCli(['post', 'create', 'post.md', '--dry-run'], h.env);
  const request = JSON.parse(h.stdout());
  assert.equal(request.body.cover_image, 'https://example.com/cover.png');
  assert.deepEqual(request.after_create, { slug: 'hello-world', section: 'Newsletters' });
});

test('without slug or section the request has no after_create', async () => {
  const post = ['---', 'title: T', '---', 'Body.'].join('\n');
  const h = envWithFiles({ 'post.md': post });
  await runCli(['post', 'create', 'post.md', '--dry-run'], h.env);
  const request = JSON.parse(h.stdout());
  assert.equal('after_create' in request, false);
});

test('command-line flags override front matter', async () => {
  const h = envWithFiles({ 'post.md': GOOD_POST });
  await runCli(
    ['post', 'create', 'post.md', '--dry-run', '--title', 'Flag title', '--audience', 'founding'],
    h.env,
  );
  const request = JSON.parse(h.stdout());
  assert.equal(request.body.draft_title, 'Flag title');
  assert.equal(request.body.audience, 'founding');
});

test('unknown front matter fields warn on stderr and are ignored', async () => {
  const post = GOOD_POST.replace(
    'slug: hello-world',
    'slug: hello-world\nauthor: Someone\ndate: 2026-08-23\nsource_url: https://other.substack.com/p/x\npublication: other',
  );
  const h = envWithFiles({ 'post.md': post });
  const code = await runCli(['post', 'create', 'post.md', '--dry-run'], h.env);
  assert.equal(code, 0);
  assert.match(h.stderr(), /ignoring unknown front matter field: author/);
  assert.match(h.stderr(), /publication/);
  const request = JSON.parse(h.stdout());
  const flat = JSON.stringify(request);
  assert.equal(flat.includes('Someone'), false);
});

test('a missing title is an error naming the two ways to set it', async () => {
  const h = envWithFiles({ 'post.md': 'Just a body, no metadata.' });
  const code = await runCli(['post', 'create', 'post.md', '--dry-run'], h.env);
  assert.equal(code, 1);
  assert.equal(h.stdout(), '');
  assert.match(h.stderr(), /missing title/);
  assert.match(h.stderr(), /front matter/);
  assert.match(h.stderr(), /--title/);
});

test('the title is never inferred from the first body line', async () => {
  const h = envWithFiles({ 'post.md': '# Looks like a title\n\nBody.' });
  const code = await runCli(['post', 'create', 'post.md', '--dry-run'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /missing title/);
});

test('without --dry-run the command fails and suggests --dry-run', async () => {
  const h = envWithFiles({ 'post.md': GOOD_POST });
  const code = await runCli(['post', 'create', 'post.md'], h.env);
  assert.equal(code, 1);
  assert.equal(h.stdout(), '');
  assert.equal(h.requests.length, 0);
  assert.match(h.stderr(), /--dry-run/);
});

test('an invalid audience is rejected', async () => {
  const h = envWithFiles({ 'post.md': '---\ntitle: T\naudience: everybody\n---\nBody.' });
  const code = await runCli(['post', 'create', 'post.md', '--dry-run'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /invalid audience "everybody"/);
});

test('an invalid slug is rejected', async () => {
  const h = envWithFiles({ 'post.md': '---\ntitle: T\nslug: Not A Slug\n---\nBody.' });
  const code = await runCli(['post', 'create', 'post.md', '--dry-run'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /invalid slug/);
});

test('a cover that is not an http(s) URL is rejected', async () => {
  const h = envWithFiles({ 'post.md': '---\ntitle: T\ncover: ./hero.png\n---\nBody.' });
  const code = await runCli(['post', 'create', 'post.md', '--dry-run'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /invalid cover/);
});

test('a sixth-level heading stops the command with exit 1', async () => {
  const post = '---\ntitle: T\n---\n\n###### Too deep\n';
  const h = envWithFiles({ 'post.md': post });
  const code = await runCli(['post', 'create', 'post.md', '--dry-run'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /sixth-level heading/);
});

test('a table stops the command with an error naming tables', async () => {
  const post = '---\ntitle: T\n---\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';
  const h = envWithFiles({ 'post.md': post });
  const code = await runCli(['post', 'create', 'post.md', '--dry-run'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /table is not supported/);
});

test('an unreadable file exits 1 with a clear message', async () => {
  const h = envWithFiles({});
  const code = await runCli(['post', 'create', 'missing.md', '--dry-run'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /cannot read missing.md/);
});

test('usage errors exit 2', async () => {
  const h = envWithFiles({ 'post.md': GOOD_POST });
  assert.equal(await runCli(['post', 'create'], h.env), 2);
  assert.equal(await runCli(['post', 'create', 'a.md', 'b.md', '--dry-run'], h.env), 2);
  assert.equal(await runCli(['post', 'create', 'post.md', '--dry-run', '--bogus'], h.env), 2);
  assert.equal(await runCli(['post'], h.env), 2);
});

test('a malformed front matter line exits 1 naming the line', async () => {
  const h = envWithFiles({ 'post.md': '---\ntitle: T\njust text\n---\nBody.' });
  const code = await runCli(['post', 'create', 'post.md', '--dry-run'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /invalid front matter line 3/);
});
