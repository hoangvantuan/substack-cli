import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { Env, HttpRequest, HttpResponse } from './types.js';

/** Builds the environment backed by the real process, network, and filesystem. */
export function createRealEnv(): Env {
  return {
    http: { request: (request) => realRequest(request) },
    fs: {
      readFile: (path) => readFile(path, 'utf8'),
      writeFile: (path, contents) => writeFile(path, contents, 'utf8'),
      mkdir: (path) => mkdir(path, { recursive: true }),
      exists: async (path) => {
        try {
          await stat(path);
          return true;
        } catch {
          return false;
        }
      },
    },
    stdin: { read: readStdin },
    stdout: { write: (text) => void process.stdout.write(text) },
    stderr: { write: (text) => void process.stderr.write(text) },
    clock: () => Date.now(),
    sleep: (ms) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    },
    vars: { ...process.env },
    homedir: () => process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.',
  };
}

async function realRequest(request: HttpRequest): Promise<HttpResponse> {
  const response = await fetch(request.url, {
    method: request.method ?? 'GET',
    headers: request.headers,
    body: request.body,
    redirect: 'follow',
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: response.status, headers, body: await response.text() };
}

async function readStdin(): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of process.stdin) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return text;
}
