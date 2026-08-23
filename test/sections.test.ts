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
    jsonResponse({ id: 21, slug: null, draft_section_id: 7 }),
    jsonResponse({ id: 21, slug: null, draft_section_id: 7 }),
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
    jsonResponse({ id: 21, slug: null, draft_section_id: 7 }),
    jsonResponse({ id: 21, slug: null, draft_section_id: null }),
  ]);
  const code = await runCli(['section', 'set', 'News', '21'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /did not stick/);
});
