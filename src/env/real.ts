import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { Env, ExecResult, HttpRequest, HttpResponse } from './types.js';

/** Builds the environment backed by the real process, network, and filesystem. */
export function createRealEnv(): Env {
  return {
    http: { request: (request) => realRequest(request) },
    exec: { run: runChild },
    fs: {
      readFile: (path) => readFile(path, 'utf8'),
      readFileBase64: async (path) => (await readFile(path)).toString('base64'),
      writeFile: (path, contents, options) =>
        writeFile(path, contents, { encoding: 'utf8', mode: options?.mode }),
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
    stdin: { read: readStdin, readHidden: readHiddenStdin },
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
/**
 * Runs a child command to completion with captured output. It blocks while
 * the child runs: `substackctl update` is the only caller and has nothing
 * else to do meanwhile. A null status means the child could not start.
 */
async function runChild(command: string, args: readonly string[]): Promise<ExecResult> {
  const result = spawnSync(command, [...args], { encoding: 'utf8', env: process.env });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
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

/**
 * Reads one line with the terminal in raw mode so nothing is echoed. Falls
 * back to plain reading when standard input is piped. Enter finishes the
 * line, backspace edits it, and Ctrl-C restores the terminal and stops.
 */
function readHiddenStdin(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || stdin.setRawMode === undefined) {
    return readStdin();
  }
  const { promise, resolve } = Promise.withResolvers<string>();
  const bytes: number[] = [];
  const finish = (): void => {
    stdin.removeListener('data', onData);
    stdin.setRawMode?.(false);
    stdin.pause();
    process.stderr.write('\n');
    resolve(new TextDecoder().decode(new Uint8Array(bytes)));
  };
  const onData = (chunk: Uint8Array): void => {
    for (let i = 0; i < chunk.length; i += 1) {
      const byte = chunk[i]!;
      if (byte === 0x0d || byte === 0x0a) {
        finish();
        return;
      }
      if (byte === 0x03) {
        process.stderr.write('\n');
        process.exit(130);
      }
      if (byte === 0x7f || byte === 0x08) {
        bytes.pop();
        continue;
      }
      bytes.push(byte);
    }
  };
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', onData);
  return promise;
}
