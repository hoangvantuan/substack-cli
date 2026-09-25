import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import type { HttpResponse } from '../src/env/types.js';
import { jsonResponse, makeEnv } from './helpers.js';

function sectionEnv(responses: HttpResponse[], sleeps: number[] = []) {
  const h = makeEnv();
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
  h.env.fs = {
    readFile: () => Promise.reject(new Error('not used')),
    writeFile: () => Promise.reject(new Error('not used')),
    mkdir: () => Promise.reject(new Error('not used')),
    exists: () => Promise.resolve(false),
  };
  h.env.sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return h;
}

const SECTIONS = [{ id: 7, name: 'News', slug: 'news' }, { id: 8, name: 'Essays', slug: 'essays' }];
const DRAFT_STATE = { id: 21, slug: null, draft_section_id: null, is_published: false, post_date: null };

test('section list prints a table of the publication sections', async () => {
  const h = sectionEnv([jsonResponse(SECTIONS)]);
  const code = await runCli(['section', 'list'], h.env);
  assert.equal(code, 0);
  const lines = h.stdout().split('\n');
  assert.match(lines[0]!, /^ID {2}NAME {4}SLUG/);
  assert.match(lines[1]!, /^7 {3}News {4}news$/);
});

test('section list --json emits the sections', async () => {
  const h = sectionEnv([jsonResponse(SECTIONS)]);
  const code = await runCli(['section', 'list', '--json'], h.env);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(h.stdout()), SECTIONS);
});

test('section set files several posts in one command, pacing between requests', async () => {
  const h = sectionEnv([
    jsonResponse(SECTIONS),
    jsonResponse(DRAFT_STATE),
    jsonResponse({ id: 21, slug: null, draft_section_id: 7 }),
    jsonResponse({ id: 21, slug: null, draft_section_id: 7 }),
    jsonResponse(DRAFT_STATE),
    jsonResponse({ id: 22, slug: null, draft_section_id: 7 }),
    jsonResponse({ id: 22, slug: null, draft_section_id: 7 }),
  ]);
  const sleeps: number[] = [];
  h.env.sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  const code = await runCli(['section', 'set', 'News', '21', '22'], h.env);
  assert.equal(code, 0);
  const puts = h.requests.filter((request) => request.method === 'PUT');
  assert.equal(puts.length, 2);
  assert.deepEqual(JSON.parse(puts[0]!.body!), { draft_section_id: 7 });
  assert.deepEqual(JSON.parse(puts[1]!.body!), { draft_section_id: 7 });
  assert.match(h.stdout(), /filed 21 under News/);
  assert.match(h.stdout(), /filed 22 under News/);
  assert.deepEqual(sleeps, [500], 'one pace between the two assignment requests');
});

test('section set skips a published post with a pointer to post revise and files the rest', async () => {
  const h = sectionEnv([
    jsonResponse(SECTIONS),
    jsonResponse({ ...DRAFT_STATE, id: 21, is_published: true, post_date: '2026-08-01T09:00:00Z' }),
    jsonResponse({ ...DRAFT_STATE, id: 22 }),
    jsonResponse({ id: 22, slug: null, draft_section_id: 7 }),
    jsonResponse({ id: 22, slug: null, draft_section_id: 7 }),
  ]);
  const code = await runCli(['section', 'set', 'News', '21', '22'], h.env);
  assert.equal(code, 1, 'a skipped post fails the run');
  assert.match(h.stderr(), /post 21 is published/);
  assert.match(h.stderr(), /sub-cli post revise 21 --section "News"/);
  const puts = h.requests.filter((request) => request.method === 'PUT');
  assert.deepEqual(puts.map((request) => request.url), ['https://envpub.substack.com/api/v1/drafts/22']);
  assert.doesNotMatch(h.stdout(), /filed 21/);
  assert.match(h.stdout(), /filed 22 under News/);
});

test('section set with an unknown section names what exists and sends no writes', async () => {
  const h = sectionEnv([jsonResponse(SECTIONS)]);
  const code = await runCli(['section', 'set', 'Nope', '21'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /unknown section "Nope"/);
  assert.match(h.stderr(), /News, Essays/);
  assert.equal(h.requests.length, 1, 'only the section lookup ran');
});

test('section set verifies against draft_section_id and fails the run when it does not stick', async () => {
  const h = sectionEnv([
    jsonResponse(SECTIONS),
    jsonResponse(DRAFT_STATE),
    jsonResponse({ id: 21, slug: null, draft_section_id: 7 }),
    jsonResponse({ id: 21, slug: null, draft_section_id: null }),
  ]);
  const code = await runCli(['section', 'set', 'News', '21'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /did not stick/);
});

test('section add creates the section and reports its identifier', async () => {
  const h = sectionEnv([
    jsonResponse(SECTIONS),
    jsonResponse({ section: { id: 9, name: 'Notes', slug: 'notes' } }),
  ]);
  const code = await runCli(['section', 'add', 'Notes', 'Short field notes'], h.env);
  assert.equal(code, 0);
  assert.deepEqual(
    h.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
    ['GET /api/v1/publication/sections', 'POST /api/v1/publication/sections'],
  );
  assert.deepEqual(JSON.parse(h.requests[1]!.body!), { name: 'Notes', description: 'Short field notes' });
  assert.match(h.stdout(), /^section 9\n/);
  assert.match(h.stdout(), /slug: notes/);
});

test('section add without a description is a usage error and sends nothing', async () => {
  const h = sectionEnv([jsonResponse(SECTIONS)]);
  const code = await runCli(['section', 'add', 'Notes'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /missing <description>/);
  assert.equal(h.requests.length, 0);
});

test('section add refuses a name the publication already uses without creating anything', async () => {
  const h = sectionEnv([jsonResponse(SECTIONS)]);
  const code = await runCli(['section', 'add', 'Essays', 'Long reads'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /section already exists: Essays/);
  assert.ok(!h.requests.some((request) => request.method === 'POST'));
});

test('section remove deletes the section named by name, slug, or id', async () => {
  for (const target of ['Essays', 'essays', '8']) {
    const h = sectionEnv([jsonResponse(SECTIONS), jsonResponse('1')]);
    const code = await runCli(['section', 'remove', target, '--yes'], h.env);
    assert.equal(code, 0, `target ${target} should be resolved`);
    assert.deepEqual(
      h.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
      ['GET /api/v1/publication/sections', 'DELETE /api/v1/publication/sections/8'],
    );
    assert.match(h.stdout(), /removed 8 \(Essays\)/);
  }
});

test('section remove without --yes refuses and sends nothing', async () => {
  const h = sectionEnv([jsonResponse(SECTIONS)]);
  const code = await runCli(['section', 'remove', 'Essays'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /without --yes/);
  assert.equal(h.requests.length, 0);
});

test('section remove names the available sections when the target is unknown', async () => {
  const h = sectionEnv([jsonResponse(SECTIONS)]);
  const code = await runCli(['section', 'remove', 'Missing', '--yes'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /unknown section "Missing"/);
  assert.match(h.stderr(), /available sections: News, Essays/);
  assert.ok(!h.requests.some((request) => request.method === 'DELETE'));
});
