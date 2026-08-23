import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { BASE_URL, BIN, COOKIE, integrationApi } from './env.js';

/**
 * Real end-to-end deletion for issue #12: create a draft through the CLI,
 * delete it through the CLI, and prove the API no longer knows it. The
 * published-refusal path is covered by unit tests with a faked state
 * response; this suite never creates a real published post.
 */


const skip = COOKIE === '' || BASE_URL === ''
  ? 'set SUBSTACK_COOKIE and SUBSTACK_PUBLICATION_URL (see .env) to run the integration suite'
  : false;

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [BIN.pathname, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SUBSTACK_PUBLICATION_URL: BASE_URL, SUBSTACK_COOKIE: COOKIE },
  });
}

const api = integrationApi;

test('a created draft is deleted for real and then reads as gone', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substackctl-delete-'));
  const file = join(dir, 'doomed.md');
  writeFileSync(file, ['---', 'title: Integration delete me', '---', '', 'Delete this body.'].join('\n'));
  try {
    const created = runCli(['post', 'create', file]);
    const id = Number(/draft (\d+)/.exec(created)![1]);

    const deleted = runCli(['post', 'delete', String(id), '--yes']);
    // A short real wait covers the API's read-after-write lag; there is no
    // deterministic signal to await across an HTTP boundary.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 500);
    await promise;
    const { status } = await api('GET', `/api/v1/drafts/${id}`);
    assert.equal(status, 404, 'the deleted draft must be gone');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

