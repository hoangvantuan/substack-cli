import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import { parseReleaseTime } from '../src/authoring/schedule.js';
import { UsageError } from '../src/exit.js';
import type { HttpResponse } from '../src/env/types.js';
import { jsonResponse, makeEnv } from './helpers.js';

function envWithFiles(files: Record<string, string>) {
  const h = makeEnv();
  h.env.fs = {
    readFile: (path: string) => {
      const contents = files[path];
      return contents === undefined ? Promise.reject(new Error(`no such file: ${path}`)) : Promise.resolve(contents);
    },
    writeFile: () => Promise.reject(new Error('not implemented')),
    mkdir: () => Promise.reject(new Error('not implemented')),
    exists: () => Promise.resolve(false),
  };
  return h;
}

const MARKDOWN = ['---', 'title: Scheduled probe', '---', '', 'Body text.'].join('\n');

/**
 * A scheduling environment: the two environment variables standing in for a
 * stored profile, and one canned response per request in order.
 */
function scheduleEnv(responses: HttpResponse[]) {
  const h = envWithFiles({ 'post.md': MARKDOWN });
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
  return h;
}

const draft = { id: 11, slug: null, draft_section_id: null, is_published: false, post_date: null };
const users = [{ id: 7, role: 'admin', is_byline_only: false }];
const activeSchedule = [{ trigger_at: '2030-01-01T02:30:00.000Z', post_audience: 'everyone' }];

test('a time without a timezone is read as machine-local time', () => {
  assert.equal(parseReleaseTime('2030-01-01T09:30').getTime(), new Date(2030, 0, 1, 9, 30).getTime());
  assert.equal(parseReleaseTime('2030-01-01 09:30:45').getTime(), new Date(2030, 0, 1, 9, 30, 45).getTime());
  assert.equal(parseReleaseTime('2030-01-01').getTime(), new Date(2030, 0, 1).getTime());
});

test('a time with a timezone is used exactly as given', () => {
  assert.equal(parseReleaseTime('2030-01-01T09:30Z').getTime(), Date.UTC(2030, 0, 1, 9, 30));
  assert.equal(parseReleaseTime('2030-01-01T09:30+07:00').getTime(), Date.UTC(2030, 0, 1, 2, 30));
  assert.equal(parseReleaseTime('2030-01-01T09:30+0700').getTime(), Date.UTC(2030, 0, 1, 2, 30));
});

test('an unreadable release time is a usage error', () => {
  const attempt = (input: string): unknown => {
    try {
      return parseReleaseTime(input);
    } catch (error) {
      return error;
    }
  };
  const first = attempt('tomorrow');
  assert.ok(first instanceof UsageError);
  const second = attempt('');
  assert.ok(second instanceof UsageError);
});

test('scheduling creates the draft and sets the release through the release endpoint', async () => {
  const h = scheduleEnv([
    jsonResponse(users),
    jsonResponse(draft),
    jsonResponse(draft),
    jsonResponse(draft),
    jsonResponse(activeSchedule),
  ]);
  const code = await runCli(['post', 'schedule', 'post.md', '2030-01-01T09:30'], h.env);
  assert.equal(code, 0);
  // users, create draft, publish-settings save, release, read-back check
  assert.equal(h.requests.length, 5);
  assert.equal(h.requests[1]!.method, 'POST');
  assert.equal(h.requests[1]!.url, 'https://envpub.substack.com/api/v1/drafts');
  const created = JSON.parse(h.requests[1]!.body!);
  assert.equal(created.audience, 'everyone');
  assert.deepEqual(created.draft_bylines, [{ id: 7, is_guest: false }]);
  // The publish-settings save that the release endpoint requires; never a publish call.
  assert.equal(h.requests[2]!.method, 'PUT');
  assert.deepEqual(JSON.parse(h.requests[2]!.body!), { section_chosen: true });
  assert.equal(h.requests[3]!.method, 'POST');
  assert.equal(h.requests[3]!.url, 'https://envpub.substack.com/api/v1/drafts/11/scheduled_release');
  const released = JSON.parse(h.requests[3]!.body!);
  assert.equal(released.trigger_at, new Date(2030, 0, 1, 9, 30).toISOString());
  assert.equal(released.post_audience, 'everyone');
  assert.equal(h.requests[4]!.method, 'GET');
  assert.equal(h.stdout(), 'scheduled 11\nrelease at: 2030-01-01T02:30:00.000Z\n');
});

test('--audience names the recipient group on both the draft and the release', async () => {
  const h = scheduleEnv([
    jsonResponse(users),
    jsonResponse(draft),
    jsonResponse(draft),
    jsonResponse(draft),
    jsonResponse([{ trigger_at: '2030-01-01T02:30:00.000Z', post_audience: 'only_paid' }]),
  ]);
  const code = await runCli(['post', 'schedule', 'post.md', '2030-01-01T09:30+07:00', '--audience', 'only_paid'], h.env);
  assert.equal(code, 0);
  assert.equal(JSON.parse(h.requests[1]!.body!).audience, 'only_paid');
  const released = JSON.parse(h.requests[3]!.body!);
  // The offset form lands on the same instant, stated in UTC on the wire.
  assert.equal(released.trigger_at, '2030-01-01T02:30:00.000Z');
  assert.equal(released.post_audience, 'only_paid');
});

test('a past release time is refused before anything is sent', async () => {
  const h = scheduleEnv([]);
  const code = await runCli(['post', 'schedule', 'post.md', '2019-01-01T09:30'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /not in the future/);
  assert.equal(h.requests.length, 0);
});

test('an invalid audience is refused without any request', async () => {
  const h = scheduleEnv([]);
  const code = await runCli(['post', 'schedule', 'post.md', '2030-01-01T09:30', '--audience', 'nobody'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /invalid audience "nobody"/);
  assert.equal(h.requests.length, 0);
});

test('missing <time> is a usage error exiting 2', async () => {
  const h = scheduleEnv([]);
  const code = await runCli(['post', 'schedule', 'post.md'], h.env);
  assert.equal(code, 2);
  assert.equal(h.requests.length, 0);
});

test('a rejected cookie exits 3', async () => {
  const h = scheduleEnv([jsonResponse({}, 401)]);
  const code = await runCli(['post', 'schedule', 'post.md', '2030-01-01T09:30'], h.env);
  assert.equal(code, 3);
});

test('a failed release removes the draft it just created', async () => {
  const h = scheduleEnv([
    jsonResponse(users),
    jsonResponse(draft),
    jsonResponse(draft),
    jsonResponse({ error: 'Please choose a section.', type: 'single' }, 400),
  ]);
  const code = await runCli(['post', 'schedule', 'post.md', '2030-01-01T09:30'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /scheduled_release failed with HTTP 400/);
  assert.equal(h.requests.length, 5);
  assert.equal(h.requests[4]!.method, 'DELETE');
  assert.equal(h.requests[4]!.url, 'https://envpub.substack.com/api/v1/drafts/11');
});

test('unscheduling removes the release and reads back an empty schedule', async () => {
  const h = envWithFiles({});
  let index = 0;
  h.env.http = {
    request: async (request) => {
      h.requests.push(request);
      const response = [jsonResponse(draft), jsonResponse(activeSchedule), jsonResponse([]), jsonResponse([])][index] ??
        jsonResponse({}, 500);
      index += 1;
      return response;
    },
  };
  h.env.vars = {
    SUBSTACK_PUBLICATION_URL: 'https://envpub.substack.com',
    SUBSTACK_COOKIE: 'env-cookie',
  };
  const code = await runCli(['post', 'unschedule', '11'], h.env);
  assert.equal(code, 0);
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests[0]!.method, 'GET');
  assert.equal(h.requests[1]!.method, 'GET');
  assert.equal(h.requests[1]!.url, 'https://envpub.substack.com/api/v1/drafts/11/scheduled_release');
  assert.equal(h.requests[2]!.method, 'DELETE');
  assert.equal(h.requests[3]!.method, 'GET');
  assert.equal(h.stdout(), 'unscheduled 11\n');
});

test('unscheduling a published post is refused and sends no delete', async () => {
  const h = envWithFiles({});
  let index = 0;
  h.env.http = {
    request: async (request) => {
      h.requests.push(request);
      const response = [jsonResponse({ ...draft, is_published: true })][index] ?? jsonResponse({}, 500);
      index += 1;
      return response;
    },
  };
  h.env.vars = {
    SUBSTACK_PUBLICATION_URL: 'https://envpub.substack.com',
    SUBSTACK_COOKIE: 'env-cookie',
  };
  const code = await runCli(['post', 'unschedule', '11'], h.env);
  assert.equal(code, 1);
  assert.equal(h.requests.length, 1);
});

test('unscheduling a post without a schedule reports it and exits 1', async () => {
  const h = envWithFiles({});
  let index = 0;
  h.env.http = {
    request: async (request) => {
      h.requests.push(request);
      const response = [jsonResponse(draft), jsonResponse([])][index] ?? jsonResponse({}, 500);
      index += 1;
      return response;
    },
  };
  h.env.vars = {
    SUBSTACK_PUBLICATION_URL: 'https://envpub.substack.com',
    SUBSTACK_COOKIE: 'env-cookie',
  };
  const code = await runCli(['post', 'unschedule', '11'], h.env);
  assert.equal(code, 1);
  assert.match(h.stderr(), /is not scheduled/);
  assert.equal(h.requests.length, 2);
});

test('a rejected cookie during unschedule exits 3', async () => {
  const h = envWithFiles({});
  let index = 0;
  h.env.http = {
    request: async (request) => {
      h.requests.push(request);
      const response = [jsonResponse({}, 403)][index] ?? jsonResponse({}, 500);
      index += 1;
      return response;
    },
  };
  h.env.vars = {
    SUBSTACK_PUBLICATION_URL: 'https://envpub.substack.com',
    SUBSTACK_COOKIE: 'env-cookie',
  };
  const code = await runCli(['post', 'unschedule', '11'], h.env);
  assert.equal(code, 3);
});
