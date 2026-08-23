import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertMarkdownToDocument } from '../../src/conversion/markdown.js';
import { BASE_URL, BIN, COOKIE, credentialsHint, hasCredentials } from './env.js';

/**
 * The manual integration suite for issue #7. It exercises the real Substack
 * API with a real cookie on the test publication (zero subscribers), creating
 * drafts that cover every supported construct and deleting them afterwards.
 *
 * It never runs under `npm test`: the flat test glob skips this directory.
 * Run it explicitly with `npm run test:integration`. Credentials come from
 * SUBSTACK_COOKIE and SUBSTACK_PUBLICATION_URL, loaded from the repository's
 * .env when present. Without them every test skips with a hint.
 */

const skipReason = hasCredentials ? false : credentialsHint;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface JsonRecord {
  [key: string]: unknown;
}

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

/** Drafts created by the current test; deleted in finally blocks. */
let createdDrafts: number[] = [];
/** Sections created by the current test; deleted in finally blocks. */
let createdSections: number[] = [];

async function deleteDraft(id: number): Promise<void> {
  await api('DELETE', `/api/v1/drafts/${id}`);
}

async function cleanup(): Promise<void> {
  for (const id of createdDrafts.splice(0)) {
    await deleteDraft(id);
  }
  for (const id of createdSections.splice(0)) {
    await api('DELETE', `/api/v1/publication/sections/${id}`);
  }
}

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [BIN.pathname, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SUBSTACK_PUBLICATION_URL: BASE_URL, SUBSTACK_COOKIE: COOKIE },
  });
}

async function ownerId(): Promise<number> {
  const { status, json } = await api('GET', '/api/v1/publication/users');
  assert.equal(status, 200);
  const users = json as JsonRecord[];
  const admin = users.find((user) => user['role'] === 'admin' && user['is_byline_only'] === false) ?? users[0]!;
  return admin['id'] as number;
}

async function createDraftFile(name: string, frontMatter: string[], body: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'substackctl-integration-'));
  const file = join(dir, name);
  writeFileSync(file, ['---', ...frontMatter, '---', '', body].join('\n'));
  return file;
}

const EVERY_CONSTRUCT_BODY = [
  '# Top level heading',
  '',
  'A paragraph with **bold**, *italic*, ~~struck~~, `inline code`, and a [link](https://example.com).',
  '',
  '## Second level',
  '',
  '### Third level',
  '',
  '- first bullet',
  '- second bullet',
  '',
  '1. first ordered',
  '2. second ordered',
  '',
  '> A wise quote.',
  '',
  '```ts',
  'const fenced = true;',
  '```',
  '',
  '---',
  '',
  '![](https://substackcdn.com/image/example.png)',
  '',
  '#### Fourth level',
  '',
  '##### Fifth level',
].join('\n');

test('every supported construct survives the create and re-read round trip', { skip: skipReason }, async () => {
  const file = await createDraftFile('constructs.md', ['title: Integration every construct'], EVERY_CONSTRUCT_BODY);
  try {
    const stdout = runCli(['post', 'create', file]);
    const match = /draft (\d+)/.exec(stdout);
    assert.ok(match, `stdout should report the draft id, got: ${stdout}`);
    const id = Number(match[1]);
    createdDrafts.push(id);
    await sleep(500);

    const local = convertMarkdownToDocument(EVERY_CONSTRUCT_BODY).document;
    const { status, json } = await api('GET', `/api/v1/drafts/${id}`);
    assert.equal(status, 200);
    const record = json as JsonRecord;
    assert.equal(record['draft_title'], 'Integration every construct');
    // The server stores the document verbatim, so the accepted body must
    // equal exactly what the converter produced.
    assert.deepEqual(JSON.parse(record['draft_body'] as string), local);
  } finally {
    await cleanup();
  }
});

test('the front matter section is assigned by the update step and verified on draft_section_id', { skip: skipReason }, async () => {
  const created = await api('POST', '/api/v1/publication/sections', {
    name: `integration section ${Date.now()}`,
    description: 'temporary section for the substackctl integration suite',
  });
  assert.equal(created.status, 200);
  const section = (created.json as JsonRecord)['section'] as JsonRecord;
  const sectionId = section['id'] as number;
  createdSections.push(sectionId);
  await sleep(500);

  const file = await createDraftFile('sectioned.md', [
    'title: Integration sectioned',
    'section: ' + (section['name'] as string),
    'slug: integration-sectioned',
  ], 'Body for the section assignment test.');
  try {
    const stdout = runCli(['post', 'create', file]);
    const match = /draft (\d+)/.exec(stdout);
    assert.ok(match, `stdout should report the draft id, got: ${stdout}`);
    const id = Number(match[1]);
    createdDrafts.push(id);
    await sleep(500);

    const { status, json } = await api('GET', `/api/v1/drafts/${id}`);
    assert.equal(status, 200);
    const record = json as JsonRecord;
    // draft_section_id is the field the API actually populates; section_id
    // always reads empty.
    assert.equal(record['draft_section_id'], sectionId);
    assert.equal(record['slug'], 'integration-sectioned');
  } finally {
    await cleanup();
  }
});

test('post list reports the created draft in the draft state', { skip: skipReason }, async () => {
  const file = await createDraftFile('listed.md', ['title: Integration listed'], 'Body for the listing test.');
  try {
    const stdout = runCli(['post', 'create', file]);
    const id = Number(/draft (\d+)/.exec(stdout)![1]);
    createdDrafts.push(id);
    await sleep(500);

    const listed = runCli(['post', 'list', '--state', 'draft', '--limit', '50', '--json']);
    const posts = JSON.parse(listed) as JsonRecord[];
    assert.ok(posts.some((post) => post['id'] === id), `created draft ${id} should appear in post list`);

    const scheduled = runCli(['post', 'list', '--state', 'scheduled', '--json']);
    assert.equal(JSON.parse(scheduled).some((post: JsonRecord) => post['id'] === id), false);
  } finally {
    await cleanup();
  }
});

test('the integration drafts are cleaned up after themselves', { skip: skipReason }, async () => {
  const { json } = await api('GET', '/api/v1/drafts?limit=49&offset=0');
  const posts = (json as JsonRecord)['posts'] as JsonRecord[];
  // Published posts deliberately stay (they cannot be recalled), so only
  // unpublished leftovers from the "Integration" suites count as debris.
  const debris = posts.filter(
    (post) => post['is_published'] !== true && String(post['draft_title'] ?? '').startsWith('Integration'),
  );
  assert.deepEqual(debris, [], 'leftover unpublished integration drafts must be deleted');
});
