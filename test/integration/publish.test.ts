import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_URL, COOKIE } from './authoring.test.js';

/**
 * The manual integration suite for issue #10. It publishes real posts on the
 * test publication (zero subscribers). Published posts are never deleted:
 * they are the deliverable, and deleting them is unnecessary on a test
 * publication. Any draft left over by a failure is removed in finally blocks.
 *
 * It never runs under `npm test`: run it explicitly with
 * `npm run test:integration`. Credentials come from SUBSTACK_COOKIE and
 * SUBSTACK_PUBLICATION_URL via authoring.test.ts.
 */
const BIN = new URL('../../../dist/bin/substackctl.js', import.meta.url);

interface JsonRecord {
  [key: string]: unknown;
}

const hasCredentials = BASE_URL !== '' && COOKIE !== '';
const skipReason = hasCredentials ? false : 'set SUBSTACK_COOKIE and SUBSTACK_PUBLICATION_URL (see .env) to run the integration suite';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      cookie: `substack.sid=${COOKIE}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: unknown = null;
  if (text !== '') {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: response.status, json };
}

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [BIN.pathname, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SUBSTACK_PUBLICATION_URL: BASE_URL, SUBSTACK_COOKIE: COOKIE },
  });
}

function writePostFile(name: string, title: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'substackctl-publish-'));
  const file = join(dir, name);
  writeFileSync(file, ['---', `title: ${title}`, '---', '', body].join('\n'));
  return file;
}

/**
 * Removes every unpublished draft this suite may have left behind (a CLI run
 * that failed between creating and publishing leaves an id we never saw).
 * Published posts are never deleted: they are the deliverable.
 */
async function cleanup(): Promise<void> {
  const { json } = await api('GET', '/api/v1/drafts?limit=49&offset=0');
  const posts = ((json as JsonRecord)['posts'] ?? []) as JsonRecord[];
  for (const post of posts) {
    const title = post['draft_title'];
    if (typeof title === 'string' && title.startsWith('Integration publish ') && post['is_published'] !== true) {
      await api('DELETE', `/api/v1/drafts/${post['id']}`);
    }
  }
}
/** Asserts a published post really is public in both the draft record and the published listing. */
async function assertPublished(id: number, expectEmail: boolean): Promise<void> {
  const { status, json } = await api('GET', `/api/v1/drafts/${id}`);
  assert.equal(status, 200);
  const record = json as JsonRecord;
  assert.equal(record['is_published'], true, `post ${id} should be published`);
  assert.equal(record['should_send_email'], expectEmail);

  const listed = await api(
    'GET',
    '/api/v1/post_management/published?offset=0&limit=50&order_by=draft_updated_at&order_direction=desc',
  );
  assert.equal(listed.status, 200);
  const posts = (listed.json as JsonRecord)['posts'] as JsonRecord[];
  assert.ok(posts.some((post) => post['id'] === id), `post ${id} should appear in the published list`);
}

test('post publish <file> creates and publishes with the email in one command', { skip: skipReason }, async () => {
  const title = `Integration publish send ${Date.now()}`;
  const file = writePostFile('publish-send.md', title, 'A body published with the email.');
  try {
    const stdout = runCli(['post', 'publish', file, '--yes', '--audience', 'everyone']);
    const match = /published (\d+)/.exec(stdout);
    assert.ok(match, `stdout should report the published id, got: ${stdout}`);
    const id = Number(match[1]);
    assert.match(stdout, /url: /);
    await sleep(500);
    await assertPublished(id, true);
  } finally {
    await cleanup();
  }
});

test('post publish <file> --no-send publishes to the web without the email', { skip: skipReason }, async () => {
  const title = `Integration publish no-send ${Date.now()}`;
  const file = writePostFile('publish-no-send.md', title, 'A body published without the email.');
  try {
    const stdout = runCli(['post', 'publish', file, '--yes', '--no-send']);
    const id = Number(/published (\d+)/.exec(stdout)![1]);
    await sleep(500);
    await assertPublished(id, false);
  } finally {
    await cleanup();
  }
});

test('post publish --id takes an existing draft public and --audience applies', { skip: skipReason }, async () => {
  const title = `Integration publish by id ${Date.now()}`;
  const file = writePostFile('publish-by-id.md', title, 'Created as a draft first, then published by identifier.');
  try {
    const created = runCli(['post', 'create', file]);
    const draftId = Number(/draft (\d+)/.exec(created)![1]);
    await sleep(500);

    const stdout = runCli(['post', 'publish', '--id', String(draftId), '--yes', '--audience', 'only_free']);
    const publishedId = Number(/published (\d+)/.exec(stdout)![1]);
    assert.equal(publishedId, draftId);
    const done = await api('GET', `/api/v1/drafts/${draftId}`);
    assert.equal((done.json as JsonRecord)['audience'], 'only_free');
    await sleep(500);
    await assertPublished(draftId, true);
  } finally {
    await cleanup();
  }
});
