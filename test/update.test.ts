import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import type { HttpResponse } from '../src/env/types.js';
import { jsonResponse, makeEnv } from './helpers.js';

function updateEnv(responses: HttpResponse[]) {
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
  return h;
}

test('post update rides section, subtitle, and slug in one PUT', async () => {
  const h = updateEnv([
    jsonResponse([{ id: 7, name: 'News', slug: 'news' }]),
    jsonResponse({ id: 31, slug: 'new-slug', draft_section_id: 7 }),
    jsonResponse({ id: 31, slug: 'new-slug', draft_section_id: 7, draft_subtitle: 'Fresh subtitle' }),
  ]);
  const code = await runCli(
    ['post', 'update', '31', '--section', 'News', '--subtitle', 'Fresh subtitle', '--slug', 'new-slug'],
    h.env,
  );
  assert.equal(code, 0);
  const puts = h.requests.filter((request) => request.method === 'PUT');
  assert.equal(puts.length, 1, 'every changed field rides one request');
  assert.deepEqual(JSON.parse(puts[0]!.body!), {
    draft_subtitle: 'Fresh subtitle',
    slug: 'new-slug',
    draft_section_id: 7,
  });
  assert.match(h.stdout(), /updated 31\nurl: https:\/\/envpub\.substack\.com\/p\/new-slug\n/);
});

test('post update reports the public URL after a slug change on a scheduled post', async () => {
  const h = updateEnv([
    jsonResponse({ id: 32, slug: null, draft_section_id: null, post_date: '2027-05-01T09:00:00Z' }),
    jsonResponse({ id: 32, slug: 'later-slug', draft_section_id: null }),
  ]);
  const code = await runCli(['post', 'update', '32', '--slug', 'later-slug'], h.env);
  assert.equal(code, 0);
  assert.match(h.stdout(), /updated 32\n/);
  assert.match(h.stdout(), /url: https:\/\/envpub\.substack\.com\/p\/later-slug\n/);
});

test('post update verifies the section against draft_section_id', async () => {
  const h = updateEnv([
    jsonResponse([{ id: 7, name: 'News', slug: 'news' }]),
    jsonResponse({ id: 33, slug: null, draft_section_id: null }),
    jsonResponse({ id: 33, slug: null, draft_section_id: null }),
  ]);
  const code = await runCli(['post', 'update', '33', '--section', 'News'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /did not stick/);
});

test('post update with nothing to change is a usage error', async () => {
  const h = updateEnv([]);
  const code = await runCli(['post', 'update', '33'], h.env);
  assert.equal(code, 2);
  assert.equal(h.requests.length, 0);
  assert.match(h.stderr(), /nothing to update/);
});

test('an unknown section is refused naming the available ones', async () => {
  const h = updateEnv([
    jsonResponse([{ id: 8, name: 'Essays', slug: 'essays' }]),
  ]);
  const code = await runCli(['post', 'update', '33', '--section', 'Nope'], h.env);
  assert.equal(code, 2);
  assert.match(h.stderr(), /unknown section "Nope"/);
  assert.match(h.stderr(), /Essays/);
});
