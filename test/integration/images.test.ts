import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_URL, BIN, COOKIE, credentialsHint, hasCredentials, integrationApi } from './env.js';

/**
 * The manual integration suite for issue #8. It exercises the real image
 * upload endpoint with a real cookie on the test publication (zero
 * subscribers): a local body image is uploaded and rewritten to its hosted
 * URL inside the stored draft body, a cover rides only in cover_image, and a
 * missing local file stops the CLI before any draft exists. Everything it
 * creates is deleted again and the deletion is asserted.
 *
 * It never runs under `npm test`: the flat test glob skips this directory.
 * Run it explicitly with `npm run test:integration`. Without credentials
 * every test skips with a hint.
 */
const skipReason = hasCredentials ? false : credentialsHint;

/** A minimal valid 1x1 red PNG, generated in code so no fixture file ships. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface JsonRecord {
  [key: string]: unknown;
}

const api = integrationApi;

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [BIN.pathname, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SUBSTACK_PUBLICATION_URL: BASE_URL, SUBSTACK_COOKIE: COOKIE },
  });
}

/** Writes one Markdown post plus a local PNG next to it in a fresh temp dir. */
function makePostDir(body: string, frontMatter = 'title: issue8 images probe'): string {
  const dir = mkdtempSync(join(tmpdir(), 'substackctl-images-'));
  writeFileSync(join(dir, 'post.md'), `---\n${frontMatter}\n---\n${body}`);
  writeFileSync(join(dir, 'probe.png'), Buffer.from(PNG_BASE64, 'base64'));
  return dir;
}

async function getDraft(id: number): Promise<JsonRecord> {
  const { status, json } = await api('GET', `/api/v1/drafts/${id}`);
  assert.equal(status, 200);
  return json as JsonRecord;
}

async function deleteDraft(id: number): Promise<void> {
  const del = await api('DELETE', `/api/v1/drafts/${id}`);
  assert.equal(del.status, 200, `deleting draft ${id} failed`);
  const gone = await api('GET', `/api/v1/drafts/${id}`);
  assert.equal(gone.status, 404, `draft ${id} survived deletion`);
}

test('a local body image is uploaded and the draft stores the hosted URL', { skip: skipReason }, async () => {
  const dir = makePostDir('\nA probe with a picture.\n\n![probe](./probe.png)\n');
  let draftId: number | null = null;
  try {
    const out = runCli(['post', 'create', join(dir, 'post.md')]);
    draftId = Number(/draft (\d+)/.exec(out)?.[1]);
    assert.ok(Number.isInteger(draftId), `no draft id in output: ${out}`);

    const draft = await getDraft(draftId);
    const body = String(draft['draft_body']);
    assert.match(body, /substack-post-media\.s3\.amazonaws\.com\/public\/images\//);
    assert.doesNotMatch(body, /probe\.png/);
    // No cover was asked for, so none appears.
    assert.equal(draft['cover_image'] ?? null, null);
  } finally {
    if (draftId !== null) {
      await deleteDraft(draftId);
    }
  }
});

test('a cover is stored as cover_image only and never injected into the body', { skip: skipReason }, async () => {
  const dir = makePostDir('\nJust text, no pictures.\n');
  let draftId: number | null = null;
  try {
    // Re-host the same tiny PNG through the real endpoint to obtain a live cover URL.
    const form = new URLSearchParams();
    form.set('image', `data:image/png;base64,${PNG_BASE64}`);
    const upload = await fetch(`${BASE_URL}/api/v1/image`, {
      method: 'POST',
      headers: { cookie: `substack.sid=${COOKIE}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    assert.equal(upload.status, 200);
    const hosted = (await upload.json() as JsonRecord)['url'];
    assert.equal(typeof hosted, 'string');

    const out = runCli(['post', 'create', join(dir, 'post.md'), '--cover', String(hosted)]);
    draftId = Number(/draft (\d+)/.exec(out)?.[1]);
    assert.ok(Number.isInteger(draftId), `no draft id in output: ${out}`);

    const draft = await getDraft(draftId);
    assert.equal(draft['cover_image'], hosted);
    assert.doesNotMatch(String(draft['draft_body']), new RegExp(String(hosted).replace(/\./g, '\\.')));
  } finally {
    if (draftId !== null) {
      await deleteDraft(draftId);
    }
  }
});

test('a missing local image stops the command with a clear error and no draft', { skip: skipReason }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substackctl-images-'));
  writeFileSync(
    join(dir, 'post.md'),
    '---\ntitle: issue8 missing image probe\n---\n\n![gone](./missing.png)\n',
  );
  const result = spawnSync(
    process.execPath,
    [BIN.pathname, 'post', 'create', join(dir, 'post.md')],
    { encoding: 'utf8', env: { ...process.env, SUBSTACK_PUBLICATION_URL: BASE_URL, SUBSTACK_COOKIE: COOKIE } },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local image not found: .*missing\.png/);
});
