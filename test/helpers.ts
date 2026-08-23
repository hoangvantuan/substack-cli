import type { Env, HttpRequest, HttpResponse } from '../src/env/types.js';

/**
 * A substituted environment for driving the CLI through its argument vector.
 * Records issued HTTP requests, sleeps, and output streams so tests can assert
 * on observable behaviour only.
 */
export interface TestHarness {
  env: Env;
  requests: HttpRequest[];
  sleeps: number[];
  stdout(): string;
  stderr(): string;
}

export function makeEnv(
  respond?: (request: HttpRequest, index: number) => HttpResponse | Promise<HttpResponse>,
): TestHarness {
  const requests: HttpRequest[] = [];
  const sleeps: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const handler = respond ?? (() => jsonResponse([]));
  let index = 0;
  const env: Env = {
    http: {
      request: async (request) => {
        requests.push(request);
        const response = await handler(request, index);
        index += 1;
        return response;
      },
    },
    fs: {
      readFile: () => Promise.reject(new Error('fs is not available in tests')),
      writeFile: () => Promise.reject(new Error('fs is not available in tests')),
      mkdir: () => Promise.reject(new Error('fs is not available in tests')),
      exists: () => Promise.reject(new Error('fs is not available in tests')),
    },
    stdin: { read: () => Promise.resolve(''), readHidden: () => Promise.resolve('') },
    stdout: { write: (text) => void out.push(text) },
    stderr: { write: (text) => void err.push(text) },
    clock: () => 1_750_000_000_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    vars: {},
    homedir: () => '/home/tester',
  };
  return { env, requests, sleeps, stdout: () => out.join(''), stderr: () => err.join('') };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): HttpResponse {
  return { status, headers, body: JSON.stringify(body) };
}

/** A raw post as the publication API returns it. */
export function postFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    slug: 'hello-world',
    title: 'Hello world',
    subtitle: 'a first post',
    post_date: '2026-08-01T09:00:00Z',
    audience: 'everyone',
    ...overrides,
  };
}
