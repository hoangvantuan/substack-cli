import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import type { HttpResponse } from '../src/env/types.js';
import { jsonResponse, makeEnv } from './helpers.js';

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

/**
 * A sending environment: the GOOD_POST file (or an override), the two
 * environment variables standing in for a stored profile, and one canned
 * response per request in order.
 */
function sendEnv(files: Record<string, string>, responses: HttpResponse[]) {
  const h = envWithFiles(Object.keys(files).length === 0 ? { 'post.md': GOOD_POST } : files);
  let index = 0;
  h.env.http = {
    request: async (request) => {
      h.requests.push(request);
      const response = responses[index] ?? jsonResponse({}, 500);
      index += 1;
      return response;
    },
  };
  h.env.vars = {
    SUBSTACK_PUBLICATION_URL: 'https://envpub.substack.com',
    SUBSTACK_COOKIE: 'env-cookie',
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

test('without --dry-run the command sends the draft and reports its id', async () => {
  const h = sendEnv({}, [
    jsonResponse([{ id: 42, role: 'admin', is_byline_only: false }]),
    jsonResponse({ id: 123, slug: null, draft_section_id: null }),
    jsonResponse({ id: 123, slug: 'hello-world', draft_section_id: null }),
    jsonResponse({ id: 123, slug: 'hello-world', draft_section_id: null }),
  ]);
  const code = await runCli(['post', 'create', 'post.md'], h.env);
  assert.equal(code, 0);
  assert.match(h.stdout(), /^draft 123\n/);
  assert.equal(h.requests.length, 4);

  const users = h.requests[0]!;
  assert.equal(users.method, 'GET');
  assert.equal(users.url, 'https://envpub.substack.com/api/v1/publication/users');
  assert.equal(users.headers?.['cookie'], 'substack.sid=env-cookie');

  const create = h.requests[1]!;
  assert.equal(create.method, 'POST');
  assert.equal(create.url, 'https://envpub.substack.com/api/v1/drafts');
  assert.equal(create.headers?.['content-type'], 'application/json');
  const body = JSON.parse(create.body!);
  assert.deepEqual(body.draft_bylines, [{ id: 42, is_guest: false }]);
  assert.deepEqual(JSON.parse(body.draft_body), {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Body with ' },
          { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
          { type: 'text', text: ' and ' },
          { type: 'text', text: 'a link', marks: [{ type: 'link', attrs: { href: 'https://example.com', title: null } }] },
          { type: 'text', text: '.' },
        ],
      },
    ],
  });
});

test('the command states its profile and publication before sending', async () => {
  const h = sendEnv({}, [
    jsonResponse([{ id: 42, role: 'admin' }]),
    jsonResponse({ id: 123, slug: null, draft_section_id: null }),
    jsonResponse({ id: 123, slug: null, draft_section_id: null }),
  ]);
  await runCli(['post', 'create', 'post.md'], h.env);
  assert.match(h.stderr(), /creating a draft on profile environment \(https:\/\/envpub\.substack\.com\)/);
});

test('a section is assigned by a separate update, verified against draft_section_id', async () => {
  const h = sendEnv({ 'post.md': ['---', 'title: T', 'section: News', '---', 'Body.'].join('\n') }, [
    jsonResponse([{ id: 42, role: 'admin' }]),
    jsonResponse([{ id: 7, name: 'News', slug: 'news' }, { id: 8, name: 'Other', slug: 'other' }]),
    jsonResponse({ id: 123, slug: null, draft_section_id: null }),
    jsonResponse({ id: 123, slug: null, draft_section_id: 7, section_id: null }),
    jsonResponse({ id: 123, slug: null, draft_section_id: 7, section_id: null }),
    jsonResponse({ id: 123, slug: null, draft_section_id: 7, section_id: null }),
  ]);
  const code = await runCli(['post', 'create', 'post.md'], h.env);
  assert.equal(code, 0);
  const update = h.requests.find((request) => request.method === 'PUT')!;
  assert.equal(update.url, 'https://envpub.substack.com/api/v1/drafts/123');
  assert.deepEqual(JSON.parse(update.body!), { draft_section_id: 7 });
  // The verification re-reads the draft; section_id stays null, only
  // draft_section_id tells the truth.
  assert.equal(h.requests.at(-1)!.url, 'https://envpub.substack.com/api/v1/drafts/123');
});

test('slug and section ride one update after creation', async () => {
  const h = sendEnv(
    { 'post.md': ['---', 'title: T', 'section: News', 'slug: hello-world', '---', 'Body.'].join('\n') },
    [
      jsonResponse([{ id: 42, role: 'admin' }]),
      jsonResponse([{ id: 7, name: 'News', slug: 'news' }]),
      jsonResponse({ id: 123, slug: null, draft_section_id: null }),
      jsonResponse({ id: 123, slug: 'hello-world', draft_section_id: 7 }),
      jsonResponse({ id: 123, slug: 'hello-world', draft_section_id: 7 }),
      jsonResponse({ id: 123, slug: 'hello-world', draft_section_id: 7 }),
    ],
  );
  const code = await runCli(['post', 'create', 'post.md'], h.env);
  assert.equal(code, 0);
  assert.equal(h.requests.filter((request) => request.method === 'PUT').length, 1);
  assert.deepEqual(JSON.parse(h.requests.find((r) => r.method === 'PUT')!.body!), {
    slug: 'hello-world',
    draft_section_id: 7,
  });
  assert.match(h.stdout(), /draft 123\nurl: https:\/\/envpub\.substack\.com\/p\/hello-world\n/);
});

test('an unknown section fails naming what exists, before any draft is created', async () => {
  const h = sendEnv({ 'post.md': ['---', 'title: T', 'section: News', '---', 'Body.'].join('\n') }, [
    jsonResponse([{ id: 42, role: 'admin' }]),
    jsonResponse([]),
  ]);
  const code = await runCli(['post', 'create', 'post.md'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /unknown section "News" \(the publication has no sections\)/);
  // The lookup used to run after the create, which left the draft behind.
  assert.ok(!h.requests.some((request) => request.url.endsWith('/api/v1/drafts')));
});

test('a section that does not stick fails verification and removes the draft', async () => {
  const h = sendEnv({ 'post.md': ['---', 'title: T', 'section: News', '---', 'Body.'].join('\n') }, [
    jsonResponse([{ id: 42, role: 'admin' }]),
    jsonResponse([{ id: 7, name: 'News', slug: 'news' }]),
    jsonResponse({ id: 123, slug: null, draft_section_id: null }),
    jsonResponse({ id: 123, slug: null, draft_section_id: null }),
    jsonResponse({ id: 123, slug: null, draft_section_id: null }),
    jsonResponse({}),
  ]);
  const code = await runCli(['post', 'create', 'post.md'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /draft_section_id is empty/);
  // A draft the command could not finish is removed rather than left behind.
  const removal = h.requests.find((request) => request.method === 'DELETE');
  assert.equal(removal?.url, 'https://envpub.substack.com/api/v1/drafts/123');
});

test('a rejected slug removes the draft the command had just created', async () => {
  const h = sendEnv({ 'post.md': ['---', 'title: T', 'slug: taken-slug', '---', 'Body.'].join('\n') }, [
    jsonResponse([{ id: 42, role: 'admin' }]),
    jsonResponse({ id: 123, slug: null, draft_section_id: null }),
    jsonResponse({ error: 'There is already another post with this slug' }, 400),
    jsonResponse({}),
  ]);
  const code = await runCli(['post', 'create', 'post.md'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /already another post with this slug/);
  const removal = h.requests.find((request) => request.method === 'DELETE');
  assert.equal(removal?.url, 'https://envpub.substack.com/api/v1/drafts/123');
});

test('a rejected cookie exits 3 and names the fix', async () => {
  const h = sendEnv({}, [jsonResponse({ errors: [] }, 401)]);
  const code = await runCli(['post', 'create', 'post.md'], h.env);
  assert.equal(code, 3);
  assert.equal(h.stdout(), '');
  assert.match(h.stderr(), /cookie.*profile login/s);
});

test('a stale stored cookie warns before sending', async () => {
  const config = {
    schemaVersion: 1,
    defaultProfile: 'test',
    profiles: {
      test: {
        publication: 'https://storedpub.substack.com',
        cookie: 'stored-cookie',
        cookieSetAt: 1_700_000_000_000,
      },
    },
  };
  const h = sendEnv({}, [
    jsonResponse([{ id: 42, role: 'admin' }]),
    jsonResponse({ id: 123, slug: null, draft_section_id: null }),
    jsonResponse({ id: 123, slug: null, draft_section_id: null }),
    jsonResponse({ id: 123, slug: 'hello-world', draft_section_id: null }),
  ]);
  delete h.env.vars['SUBSTACK_PUBLICATION_URL'];
  delete h.env.vars['SUBSTACK_COOKIE'];
  h.env.fs = {
    readFile: (path: string) =>
      path === '/home/tester/.config/sub-cli/config.json'
        ? Promise.resolve(JSON.stringify(config))
        : Promise.resolve(GOOD_POST),
    writeFile: () => Promise.reject(new Error('not used')),
    mkdir: () => Promise.reject(new Error('not used')),
    exists: (path: string) => Promise.resolve(path.endsWith('config.json')),
  };
  const code = await runCli(['post', 'create', 'post.md', '--profile', 'test'], h.env);
  assert.equal(code, 0);
  assert.match(h.stderr(), /warning: the cookie for test is \d+ days old/);
  assert.match(h.stderr(), /creating a draft on profile test \(https:\/\/storedpub\.substack\.com\)/);
  assert.equal(h.requests[0]!.headers?.['cookie'], 'substack.sid=stored-cookie');
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
