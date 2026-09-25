import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import type { HttpRequest, HttpResponse } from '../src/env/types.js';
import { jsonResponse, makeEnv, type TestHarness } from './helpers.js';

/**
 * Tests for `post revise` (issue #15, ADR 0006). The fake publication keeps
 * a published post the way Substack does: live `title`/`subtitle`/`body`/
 * `section_id` next to staged `draft_*` copies. A PUT stages the content
 * fields and applies slug and cover at once; a republish copies the staged
 * fields to the live ones.
 */

const PUB = 'https://envpub.substack.com';
const HOSTED = 'https://substack-post-media.s3.amazonaws.com/public/images/probe.png';
const SECTIONS = [{ id: 7, name: 'News', slug: 'news' }];
const LIVE_BODY = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old body.' }] }] });
// 2026-09-25T15:00:00.000Z
const NOW = Date.UTC(2026, 8, 25, 15, 0, 0);
const BACKUP = '/home/tester/.config/sub-cli/backups/envpub.substack.com/55-20260925T150000Z.md';

type Record_ = Record<string, unknown>;

interface ReviseOptions {
  state?: 'draft' | 'scheduled' | 'published';
  /** Overrides applied to the stored post before the run, e.g. pending changes. */
  post?: Record_;
  files?: Record<string, string>;
  /** Stored profiles; without it the two environment variables name the publication. */
  config?: string;
  /** When false the republish answers 200 but copies nothing, for verification failures. */
  republishCopies?: boolean;
  /** Fields a PUT answers 200 for but never stores. */
  putDrops?: string[];
}

interface ReviseHarness extends TestHarness {
  post: Record_;
  written: Map<string, string>;
}

function reviseEnv(options: ReviseOptions = {}): ReviseHarness {
  const state = options.state ?? 'published';
  const files = options.files ?? {};
  const written = new Map<string, string>();
  const post: Record_ = {
    id: 55,
    slug: 'current-slug',
    is_published: state === 'published',
    post_date: state === 'draft' ? null : '2026-09-01T09:00:00.000Z',
    title: 'Live title',
    draft_title: 'Live title',
    subtitle: 'Live subtitle',
    draft_subtitle: 'Live subtitle',
    body: LIVE_BODY,
    draft_body: LIVE_BODY,
    section_id: null,
    draft_section_id: null,
    cover_image: null,
    ...options.post,
  };
  const h = makeEnv((request: HttpRequest): HttpResponse => {
    const path = new URL(request.url).pathname;
    if (path === '/api/v1/publication/sections') {
      return jsonResponse(SECTIONS);
    }
    if (path === '/api/v1/image') {
      return jsonResponse({ id: 42, url: HOSTED });
    }
    if (path === `/api/v1/posts/${post['slug']}`) {
      return jsonResponse({
        id: 55,
        slug: post['slug'],
        title: post['title'],
        subtitle: post['subtitle'],
        cover_image: post['cover_image'],
        post_date: post['post_date'],
        body_html: '<h2>Heading</h2><p>Old <strong>body</strong>.</p>',
      });
    }
    if (path === '/api/v1/drafts/55/publish' && request.method === 'POST') {
      if (options.republishCopies !== false) {
        post['title'] = post['draft_title'];
        post['subtitle'] = post['draft_subtitle'];
        post['body'] = post['draft_body'];
        post['section_id'] = post['draft_section_id'];
      }
      return jsonResponse(post);
    }
    if (path === '/api/v1/drafts/55') {
      if (request.method === 'PUT') {
        const patch = JSON.parse(request.body!) as Record_;
        for (const key of options.putDrops ?? []) delete patch[key];
        Object.assign(post, patch);
      }
      return jsonResponse(post);
    }
    return jsonResponse({}, 404);
  });
  h.env.clock = () => NOW;
  h.env.fs = {
    readFile: (path) => {
      if (path.endsWith('/config.json') && options.config !== undefined) {
        return Promise.resolve(options.config);
      }
      return path in files ? Promise.resolve(files[path]!) : Promise.reject(new Error(`no such file: ${path}`));
    },
    writeFile: (path, contents) => {
      written.set(path, contents);
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(),
    exists: (path) => Promise.resolve(path in files || (path.endsWith('/config.json') && options.config !== undefined)),
    readFileBase64: (path) =>
      path in files ? Promise.resolve(files[path]!) : Promise.reject(new Error(`no such file: ${path}`)),
  };
  h.env.vars = options.config === undefined
    ? { SUB_CLI_NO_UPDATE_CHECK: '1', SUBSTACK_PUBLICATION_URL: PUB, SUBSTACK_COOKIE: 'env-cookie' }
    : { SUB_CLI_NO_UPDATE_CHECK: '1' };
  return Object.assign(h, { post, written });
}

function calls(h: TestHarness): string[] {
  return h.requests.map((request) => `${request.method ?? 'GET'} ${new URL(request.url).pathname}`);
}

function writes(h: TestHarness): string[] {
  return calls(h).filter((call) => !call.startsWith('GET '));
}

function putBody(h: TestHarness): Record_ {
  const put = h.requests.find((request) => request.method === 'PUT');
  assert.ok(put !== undefined, 'no PUT was sent');
  return JSON.parse(put.body!);
}

const NEW_POST = ['---', 'title: New title', '---', '', 'New **body**.'].join('\n');
const CONFIRM = ['--yes'];

test('without --yes it refuses before any request', async () => {
  const h = reviseEnv();
  const code = await runCli(['post', 'revise', '55', '--title', 'T'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /refusing to revise/);
  assert.match(h.stderr(), /--yes/);
  assert.equal(h.requests.length, 0);
});

test('the default profile is ignored: without --profile it refuses', async () => {
  const config = JSON.stringify({
    schemaVersion: 1,
    defaultProfile: 'main',
    profiles: { main: { publication: PUB, cookie: 'c', cookieSetAt: NOW } },
  });
  const h = reviseEnv({ config });
  const code = await runCli(['post', 'revise', '55', '--title', 'T', '--yes'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /--profile <name>/);
  assert.equal(h.requests.length, 0);
});

test('an explicit --profile unlocks it', async () => {
  const config = JSON.stringify({
    schemaVersion: 1,
    defaultProfile: null,
    profiles: { main: { publication: PUB, cookie: 'c', cookieSetAt: NOW } },
  });
  const h = reviseEnv({ config });
  const code = await runCli(['post', 'revise', '55', '--title', 'T', '--profile', 'main', '--yes'], h.env);
  assert.equal(code, 0, h.stderr());
});

test('with nothing to change it is a usage error and sends nothing', async () => {
  const h = reviseEnv();
  const code = await runCli(['post', 'revise', '55', ...CONFIRM], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /nothing to revise/);
  assert.equal(h.requests.length, 0);
});

for (const state of ['draft', 'scheduled'] as const) {
  test(`a ${state} post is refused with a pointer to post update`, async () => {
    const h = reviseEnv({ state });
    const code = await runCli(['post', 'revise', '55', '--title', 'T', ...CONFIRM], h.env);
    assert.equal(code, 1);
    assert.match(h.stderr(), /published posts only/);
    assert.match(h.stderr(), /sub-cli post update 55/);
    assert.deepEqual(writes(h), []);
    assert.equal(h.written.size, 0);
  });
}

test('a file revises title and body: backup, stage, republish without email, verify', async () => {
  const h = reviseEnv({ files: { 'post.md': NEW_POST } });
  const code = await runCli(['post', 'revise', '55', 'post.md', ...CONFIRM], h.env);
  assert.equal(code, 0, h.stderr());
  assert.deepEqual(calls(h), [
    'GET /api/v1/drafts/55',
    'GET /api/v1/posts/current-slug',
    'PUT /api/v1/drafts/55',
    'POST /api/v1/drafts/55/publish',
    'GET /api/v1/drafts/55',
  ]);
  const body = putBody(h);
  assert.deepEqual(Object.keys(body).sort(), ['draft_body', 'draft_title']);
  assert.equal(body['draft_title'], 'New title');
  assert.match(body['draft_body'] as string, /"text":"body"/);
  const publish = h.requests.find((request) => request.url.endsWith('/publish'))!;
  assert.deepEqual(JSON.parse(publish.body!), { send: false, share_automatically: false });
  assert.equal(h.post['title'], 'New title');
  assert.match(h.stdout(), /^backup: .*\nrevised 55\nurl: https:\/\/envpub\.substack\.com\/p\/current-slug\n$/);
});

test('the backup is the live post as Markdown, readable back as a revise file', async () => {
  const h = reviseEnv({ files: { 'post.md': NEW_POST } });
  const code = await runCli(['post', 'revise', '55', 'post.md', ...CONFIRM], h.env);
  assert.equal(code, 0, h.stderr());
  assert.match(h.stdout(), new RegExp(`backup: ${BACKUP.replace(/[./]/g, '\\$&')}\\n`));
  const backup = h.written.get(BACKUP);
  assert.ok(backup !== undefined, `nothing written to ${BACKUP}: ${[...h.written.keys()].join(', ')}`);
  assert.match(backup, /^---\ntitle: "Live title"\nsubtitle: "Live subtitle"\nslug: "current-slug"\n---\n/);
  assert.match(backup, /# Heading/);
  assert.match(backup, /Old \*\*body\*\*\./);
});

test('a backup that cannot be written stops the revision before any write', async () => {
  const h = reviseEnv({ files: { 'post.md': NEW_POST } });
  h.env.fs.writeFile = () => Promise.reject(new Error('disk full'));
  const code = await runCli(['post', 'revise', '55', 'post.md', ...CONFIRM], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /disk full/);
  assert.deepEqual(writes(h), []);
});

test('metadata flags alone revise without touching the body', async () => {
  const h = reviseEnv();
  const code = await runCli(
    ['post', 'revise', '55', '--title', 'T', '--subtitle', 'S', '--section', 'News', '--cover', 'https://example.com/c.png', ...CONFIRM],
    h.env,
  );
  assert.equal(code, 0, h.stderr());
  assert.deepEqual(putBody(h), {
    draft_title: 'T',
    draft_subtitle: 'S',
    cover_image: 'https://example.com/c.png',
    draft_section_id: 7,
  });
  assert.equal(h.post['section_id'], 7);
});

test('the file names title and body; subtitle, cover, section change only when named', async () => {
  const post = NEW_POST.replace('title: New title', 'title: New title\nsubtitle: From file');
  const h = reviseEnv({ files: { 'post.md': post } });
  const code = await runCli(['post', 'revise', '55', 'post.md', '--title', 'Flag title', ...CONFIRM], h.env);
  assert.equal(code, 0, h.stderr());
  const body = putBody(h);
  assert.deepEqual(Object.keys(body).sort(), ['draft_body', 'draft_subtitle', 'draft_title']);
  assert.equal(body['draft_title'], 'Flag title');
  assert.equal(body['draft_subtitle'], 'From file');
});

test('local images in the file are uploaded before the write', async () => {
  const h = reviseEnv({ files: { 'posts/post.md': NEW_POST + '\n\n![p](./pic.png)\n', 'posts/pic.png': 'AAAA' } });
  const code = await runCli(['post', 'revise', '55', 'posts/post.md', ...CONFIRM], h.env);
  assert.equal(code, 0, h.stderr());
  assert.ok(calls(h).includes('POST /api/v1/image'));
  assert.doesNotMatch(putBody(h)['draft_body'] as string, /pic\.png/);
});

test('an audience in the front matter is ignored with a warning', async () => {
  const post = NEW_POST.replace('title: New title', 'title: New title\naudience: only_paid');
  const h = reviseEnv({ files: { 'post.md': post } });
  const code = await runCli(['post', 'revise', '55', 'post.md', ...CONFIRM], h.env);
  assert.equal(code, 0, h.stderr());
  assert.match(h.stderr(), /ignoring front matter field "audience"/);
  assert.equal('audience' in putBody(h), false);
});

test('pending changes the revision would not overwrite are refused, listing the fields', async () => {
  const h = reviseEnv({ post: { draft_subtitle: 'Unpushed subtitle', draft_body: '{"type":"doc","content":[]}' } });
  const code = await runCli(['post', 'revise', '55', '--title', 'T', ...CONFIRM], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /pending changes/);
  assert.match(h.stderr(), /subtitle, body/);
  assert.deepEqual(writes(h), []);
  assert.equal(h.written.size, 0, 'no backup before a refusal');
});

test('a pending section counts as a pending change', async () => {
  const h = reviseEnv({ post: { draft_section_id: 7 } });
  const code = await runCli(['post', 'revise', '55', '--title', 'T', ...CONFIRM], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /pending changes \(section\)/);
});

test('pending changes the revision overwrites do not block it', async () => {
  const h = reviseEnv({
    post: { draft_title: 'Unpushed title', draft_body: '{"type":"doc","content":[]}' },
    files: { 'post.md': NEW_POST },
  });
  const code = await runCli(['post', 'revise', '55', 'post.md', ...CONFIRM], h.env);
  assert.equal(code, 0, h.stderr());
});

test('a null subtitle and an empty staged subtitle are not a pending change', async () => {
  const h = reviseEnv({ post: { subtitle: null, draft_subtitle: '' } });
  const code = await runCli(['post', 'revise', '55', '--title', 'T', ...CONFIRM], h.env);
  assert.equal(code, 0, h.stderr());
});

test('a front matter slug equal to the current one is a no-op', async () => {
  const post = NEW_POST.replace('title: New title', 'title: New title\nslug: current-slug');
  const h = reviseEnv({ files: { 'post.md': post } });
  const code = await runCli(['post', 'revise', '55', 'post.md', ...CONFIRM], h.env);
  assert.equal(code, 0, h.stderr());
  assert.equal('slug' in putBody(h), false);
});

test('a different slug is refused without --change-url, explaining the frozen old URL', async () => {
  const h = reviseEnv();
  const code = await runCli(['post', 'revise', '55', '--slug', 'new-slug', ...CONFIRM], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /no redirect/);
  assert.match(h.stderr(), /frozen copy/);
  assert.match(h.stderr(), /--change-url/);
  assert.deepEqual(writes(h), []);
});

test('a different slug from the file is refused the same way', async () => {
  const post = NEW_POST.replace('title: New title', 'title: New title\nslug: from-file');
  const h = reviseEnv({ files: { 'post.md': post } });
  const code = await runCli(['post', 'revise', '55', 'post.md', ...CONFIRM], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /--change-url/);
});

test('--change-url changes the slug with a warning and prints the new URL', async () => {
  const h = reviseEnv();
  const code = await runCli(['post', 'revise', '55', '--slug', 'new-slug', '--change-url', ...CONFIRM], h.env);
  assert.equal(code, 0, h.stderr());
  assert.match(h.stderr(), /warning: .*no redirect.*frozen copy/);
  assert.equal(putBody(h)['slug'], 'new-slug');
  assert.match(h.stdout(), /url: https:\/\/envpub\.substack\.com\/p\/new-slug\n/);
});

test('--dry-run prints the requests, the backup path, and the pending check; writes nothing', async () => {
  const post = NEW_POST.replace('title: New title', 'title: New title\nsection: News');
  const h = reviseEnv({ files: { 'post.md': post } });
  const code = await runCli(['post', 'revise', '55', 'post.md', '--dry-run'], h.env);
  assert.equal(code, 0, h.stderr());
  assert.deepEqual(calls(h), ['GET /api/v1/drafts/55']);
  assert.equal(h.written.size, 0);
  const preview = JSON.parse(h.stdout());
  assert.equal(preview.backup, BACKUP);
  assert.deepEqual(preview.pending_changes, []);
  assert.equal(preview.requests[0].method, 'PUT');
  assert.equal(preview.requests[0].url, '/api/v1/drafts/55');
  assert.equal(preview.requests[0].body.draft_title, 'New title');
  assert.equal(preview.requests[0].section, 'News');
  assert.deepEqual(preview.requests[1], {
    method: 'POST',
    url: '/api/v1/drafts/55/publish',
    body: { send: false, share_automatically: false },
  });
});

test('--dry-run reports pending changes and fails like the real run', async () => {
  const h = reviseEnv({ post: { draft_subtitle: 'Unpushed' } });
  const code = await runCli(['post', 'revise', '55', '--title', 'T', '--dry-run'], h.env);
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(h.stdout()).pending_changes, ['subtitle']);
  assert.match(h.stderr(), /pending changes \(subtitle\)/);
});

test('a republish that does not take is reported as a failure', async () => {
  const h = reviseEnv({ republishCopies: false });
  const code = await runCli(['post', 'revise', '55', '--title', 'T', ...CONFIRM], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /did not go live.*title/);
  assert.doesNotMatch(h.stdout(), /revised/);
});

test('--dry-run previews a URL change it would refuse, then fails like the real run', async () => {
  const h = reviseEnv();
  const code = await runCli(['post', 'revise', '55', '--slug', 'new-slug', '--dry-run'], h.env);
  assert.equal(code, 1);
  assert.equal(JSON.parse(h.stdout()).requests[0].body.slug, 'new-slug');
  assert.match(h.stderr(), /--change-url/);
});

test('a body the PUT silently dropped is reported as not live', async () => {
  const h = reviseEnv({ files: { 'post.md': NEW_POST }, putDrops: ['draft_body'] });
  const code = await runCli(['post', 'revise', '55', 'post.md', ...CONFIRM], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /did not go live: body/);
});
