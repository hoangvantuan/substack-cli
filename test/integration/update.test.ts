import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_URL, BIN, COOKIE, credentialsHint, hasCredentials, integrationApi } from './env.js';

/**
 * Real end-to-end coverage for issue #14: `post update --file` replaces a
 * real draft's title and body, and `post update` refuses a published post
 * without writing to it. The draft created here is deleted afterwards; the
 * published post is only read.
 */

const skip = hasCredentials ? false : credentialsHint;
const cliEnv = { ...process.env, SUBSTACK_PUBLICATION_URL: BASE_URL, SUBSTACK_COOKIE: COOKIE };

function writePost(title: string, body: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'sub-cli-update-')), 'post.md');
  writeFileSync(file, ['---', `title: ${title}`, '---', '', body].join('\n'));
  return file;
}

test('post update --file replaces a draft title and body', { skip }, async () => {
  let draftId: number | null = null;
  try {
    const created = execFileSync(process.execPath, [BIN.pathname, 'post', 'create', writePost('Integration update before', 'Old body.')], {
      encoding: 'utf8',
      env: cliEnv,
    });
    draftId = Number(/draft (\d+)/.exec(created)![1]);
    const marker = `New body ${Date.now()}.`;
    const updated = execFileSync(
      process.execPath,
      [BIN.pathname, 'post', 'update', String(draftId), '--file', writePost('Integration update after', marker)],
      { encoding: 'utf8', env: cliEnv },
    );
    assert.match(updated, new RegExp(`updated ${draftId}\\n`));
    const { status, json } = await integrationApi('GET', `/api/v1/drafts/${draftId}`);
    assert.equal(status, 200);
    const record = json as Record<string, unknown>;
    assert.equal(record['draft_title'], 'Integration update after');
    assert.match(String(record['draft_body']), new RegExp(marker.replace('.', '\\.')));
    assert.doesNotMatch(String(record['draft_body']), /Old body/);
  } finally {
    if (draftId !== null) {
      await integrationApi('DELETE', `/api/v1/drafts/${draftId}`);
    }
  }
});

test('post update refuses a published post and leaves it untouched', { skip }, async () => {
  const listing = await integrationApi(
    'GET',
    '/api/v1/post_management/published?offset=0&limit=1&order_by=draft_updated_at&order_direction=desc',
  );
  const post = ((listing.json as Record<string, unknown>)['posts'] as Record<string, unknown>[] | undefined)?.[0];
  if (post === undefined) {
    return;
  }
  const id = post['id'] as number;
  const before = (await integrationApi('GET', `/api/v1/drafts/${id}`)).json as Record<string, unknown>;
  const result = spawnSync(process.execPath, [BIN.pathname, 'post', 'update', String(id), '--subtitle', 'must not land'], {
    encoding: 'utf8',
    env: cliEnv,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`sub-cli post revise ${id}`));
  const after = (await integrationApi('GET', `/api/v1/drafts/${id}`)).json as Record<string, unknown>;
  assert.equal(after['draft_subtitle'], before['draft_subtitle']);
});
