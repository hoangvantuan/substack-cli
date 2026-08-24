import type { Env, HttpRequest, HttpResponse } from '../src/env/types.js';

/**
 * A substituted environment for driving the CLI through its argument vector.
 * Records issued HTTP requests, child commands, sleeps, and output streams
 * so tests can assert on observable behaviour only.
 */
export interface TestHarness {
  env: Env;
  requests: HttpRequest[];
  /** Every child command the CLI ran, in order. */
  execs: Array<{ command: string; args: string[] }>;
  sleeps: number[];
  stdout(): string;
  stderr(): string;
}

export function makeEnv(
  respond?: (request: HttpRequest, index: number) => HttpResponse | Promise<HttpResponse>,
): TestHarness {
  const requests: HttpRequest[] = [];
  const execs: Array<{ command: string; args: string[] }> = [];
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
    exec: {
      // Succeeds by default; tests override env.exec when they need a failure.
      run: async (command, args) => {
        execs.push({ command, args: [...args] });
        return { code: 0, stdout: '', stderr: '' };
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
    // The update warning has its own suite; every other test stays offline
    // and deterministic by default.
    vars: { SUB_CLI_NO_UPDATE_CHECK: '1' },
    homedir: () => '/home/tester',
  };
  return { env, requests, execs, sleeps, stdout: () => out.join(''), stderr: () => err.join('') };
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
