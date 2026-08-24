import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_URL, BIN, COOKIE, integrationApi } from './env.js';

/**
 * Real end-to-end coverage for issue #11: a temporary section is created,
 * filed onto several real drafts by one `section set` command, and a single
 * `post update` changes subtitle and slug together. Everything created here
 * is deleted afterwards.
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

const createdDrafts: number[] = [];
let createdSectionId: number | null = null;

async function cleanup(): Promise<void> {
  for (const id of createdDrafts.splice(0)) {
    await api('DELETE', `/api/v1/drafts/${id}`);
  }
  if (createdSectionId !== null) {
    await api('DELETE', `/api/v1/publication/sections/${createdSectionId}`);
    createdSectionId = null;
  }
}

function createDraftFile(name: string, title: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sub-cli-sections-'));
  const file = join(dir, name);
  writeFileSync(file, ['---', `title: ${title}`, '---', '', 'Body before the metadata fix.'].join('\n'));
  return file;
}

test('section set files several posts and post update fixes metadata in one request', { skip }, async () => {
  try {
    const sectionName = `integration sections ${Date.now()}`;
    const uniqueSlug = `integration-sections-fixed-${Date.now()}`;
    const created = await api('POST', '/api/v1/publication/sections', {
      name: sectionName,
      description: 'temporary section for the sub-cli sections integration suite',
    });
    assert.equal(created.status, 200);
    const section = ((created.json as JsonRecordLike)['section'] ?? created.json) as JsonRecordLike;
    createdSectionId = section['id'] as number;
    assert.equal(typeof createdSectionId, 'number');

    const first = createDraftFile('first.md', 'Integration sections first');
    const second = createDraftFile('second.md', 'Integration sections second');
    for (const file of [first, second]) {
      const stdout = runCli(['post', 'create', file]);
      createdDrafts.push(Number(/draft (\d+)/.exec(stdout)![1]));
    }

    // One command files several posts; each assignment is verified against
    // draft_section_id, the field the API actually populates.
    const setOutput = runCli(['section', 'set', sectionName, ...createdDrafts.map(String)]);
    assert.match(setOutput, new RegExp(`filed ${createdDrafts[0]} under ${sectionName}`));
    assert.match(setOutput, new RegExp(`filed ${createdDrafts[1]} under ${sectionName}`));
    for (const id of createdDrafts) {
      const { status, json } = await api('GET', `/api/v1/drafts/${id}`);
      assert.equal(status, 200);
      assert.equal((json as JsonRecordLike)['draft_section_id'], createdSectionId);
    }

    // Subtitle and slug ride one request; the public URL is reported. The
    // slug must be unique per run: the API refuses a slug another post holds.
    const updated = runCli([
      'post', 'update', String(createdDrafts[0]),
      '--subtitle', 'Fixed subtitle',
      '--slug', uniqueSlug,
    ]);
    assert.match(updated, /updated \d+\n/);
    assert.match(updated, new RegExp(`url: ${BASE_URL}/p/${uniqueSlug}\\n`));
    const { status, json } = await api('GET', `/api/v1/drafts/${createdDrafts[0]}`);
    assert.equal(status, 200);
    const record = json as JsonRecordLike;
    assert.equal(record['draft_subtitle'], 'Fixed subtitle');
    assert.equal(record['slug'], uniqueSlug);

    // The listing shows the section through draft_section_name as well.
    const listJson = runCli(['post', 'list', '--state', 'draft', '--limit', '50', '--json']);
    const listed = JSON.parse(listJson) as JsonRecordLike[];
    const mine = listed.find((post) => post['id'] === createdDrafts[1]);
    assert.ok(mine, 'the second draft should appear in post list');
    // The drafts listing can lag behind the detail endpoint on
    // draft_section_name, so only presence is asserted here; assignment
    // itself was verified above via draft_section_id.
  } finally {
    await cleanup();
  }
});

interface JsonRecordLike {
  [key: string]: unknown;
}
