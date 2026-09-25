import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_URL, BIN, COOKIE, credentialsHint, hasCredentials, integrationApi } from './env.js';

/**
 * Real end-to-end coverage for issue #15: `post revise` changes a published
 * post in place without re-sending the email or moving its date, and refuses
 * a post with pending changes. Each test publishes its own post with
 * --no-send; published posts are left in place, as the publish suite does.
 */

const skip = hasCredentials ? false : credentialsHint;
// Backups land in a throwaway config root, never in the real one.
const configRoot = mkdtempSync(join(tmpdir(), 'sub-cli-revise-config-'));
const cliEnv = { ...process.env, SUBSTACK_PUBLICATION_URL: BASE_URL, SUBSTACK_COOKIE: COOKIE, XDG_CONFIG_HOME: configRoot };

type JsonRecord = Record<string, unknown>;

function writePost(title: string, body: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'sub-cli-revise-')), 'post.md');
  writeFileSync(file, ['---', `title: ${title}`, '---', '', body].join('\n'));
  return file;
}

function cli(args: string[]): string {
  return execFileSync(process.execPath, [BIN.pathname, ...args], { encoding: 'utf8', env: cliEnv });
}

function publishFresh(label: string): number {
  const stamp = Date.now();
  const out = cli(['post', 'publish', writePost(`Integration revise ${label} ${stamp}`, `Original body ${stamp}.`), '--yes', '--no-send']);
  return Number(/published (\d+)/.exec(out)![1]);
}

async function draft(id: number): Promise<JsonRecord> {
  const { status, json } = await integrationApi('GET', `/api/v1/drafts/${id}`);
  assert.equal(status, 200);
  return json as JsonRecord;
}

test('post revise changes a published post live, without email, keeping its date', { skip }, async () => {
  const id = publishFresh('content');
  const before = await draft(id);
  const marker = `Revised body ${Date.now()}.`;
  const out = cli(['post', 'revise', String(id), writePost('Integration revise content revised', marker), '--subtitle', 'Revised subtitle', '--yes']);
  assert.match(out, new RegExp(`revised ${id}\\n`));
  const backup = /backup: (.+)\n/.exec(out)![1]!;
  assert.match(readFileSync(backup, 'utf8'), /Original body/);

  const after = await draft(id);
  assert.equal(after['title'], 'Integration revise content revised');
  assert.equal(after['subtitle'], 'Revised subtitle');
  assert.equal(after['body'], after['draft_body']);
  assert.match(String(after['body']), new RegExp(marker.replace('.', '\\.')));
  assert.equal(after['post_date'], before['post_date']);
  assert.equal(after['should_send_email'], false);
  assert.equal(after['email_sent_at'] ?? null, null);

  const live = await integrationApi('GET', `/api/v1/posts/${after['slug']}`);
  assert.equal(live.status, 200);
  assert.match(String((live.json as JsonRecord)['body_html']), new RegExp(marker.replace('.', '\\.')));
});

test('post revise refuses pending changes and leaves the live post untouched', { skip }, async () => {
  const id = publishFresh('pending');
  await integrationApi('PUT', `/api/v1/drafts/${id}`, { draft_subtitle: 'Unpushed subtitle' });
  const before = await draft(id);
  const result = spawnSync(process.execPath, [BIN.pathname, 'post', 'revise', String(id), '--title', 'Must not land', '--yes'], {
    encoding: 'utf8',
    env: cliEnv,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /pending changes \(subtitle\)/);
  const after = await draft(id);
  assert.equal(after['title'], before['title']);
  assert.equal(after['draft_title'], before['draft_title']);
});
