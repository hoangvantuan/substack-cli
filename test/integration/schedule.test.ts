import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { BASE_URL, BIN, COOKIE, integrationApi } from './env.js';

/**
 * Real end-to-end scheduling for issue #9: schedule a post into the far
 * future through the CLI, see it under the scheduled filter, pull it back
 * with unschedule, and delete it. The suite only ever touches drafts it
 * created itself; nothing published is involved.
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

function wait(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

test('a scheduled post appears under the scheduled filter and unschedules back to a draft', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substackctl-schedule-'));
  const file = join(dir, 'later.md');
  writeFileSync(file, ['---', 'title: Integration schedule me', '---', '', 'Schedule this body.'].join('\n'));
  // A timezone-less time exercises the machine-local interpretation end to end.
  const when = new Date(Date.now() + 60 * 24 * 3600 * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const localTime =
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}:${pad(when.getMinutes())}`;
  try {
    const scheduled = runCli(['post', 'schedule', file, localTime]);
    const id = Number(/scheduled (\d+)/.exec(scheduled)![1]);

    try {
      await wait(500);
      // The release endpoint holds exactly one future trigger for the draft.
      const release = await api('GET', `/api/v1/drafts/${id}/scheduled_release`);
      const entries = Array.isArray(release.json) ? release.json as Array<Record<string, unknown>> : [];
      assert.equal(entries.length, 1, 'the draft must hold one scheduled release');
      assert.match(String(entries[0]!['trigger_at']), /^20\d\d-/);

      // The scheduled filter of `post list` knows the post.
      const listed = runCli(['post', 'list', '--state', 'scheduled']);
      assert.match(listed, new RegExp(`\\b${id}\\b`));

      // Pull it back: no release left, the post reads as a plain draft.
      const pulled = runCli(['post', 'unschedule', String(id)]);
      assert.match(pulled, new RegExp(`unscheduled ${id}`));
      await wait(500);
      const after = await api('GET', `/api/v1/drafts/${id}/scheduled_release`);
      assert.deepEqual(after.json, [], 'the schedule must be gone after unscheduling');
      const state = await api('GET', `/api/v1/drafts/${id}`);
      const record = state.json as Record<string, unknown>;
      assert.equal(record['is_published'], false);
      const stillListed = runCli(['post', 'list', '--state', 'scheduled']);
      assert.doesNotMatch(stillListed, new RegExp(`\\b${id}\\b`));
    } finally {
      // Dọn dẹp bắt buộc: draft do suite tạo phải biến mất kể cả khi assert hỏng.
      try {
        runCli(['post', 'delete', String(id), '--yes']);
      } catch {
        execFileSync(process.execPath, [BIN.pathname, 'post', 'delete', String(id), '--force-published', '--yes'], {
          encoding: 'utf8',
          env: { ...process.env, SUBSTACK_PUBLICATION_URL: BASE_URL, SUBSTACK_COOKIE: COOKIE },
        });
      }
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});
