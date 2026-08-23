/**
 * Minimal ambient declarations for the Node APIs this tool touches.
 * The project deliberately ships without @types/node; only the surface the
 * real environment adapter uses is declared here.
 */

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  stdin: AsyncIterable<Uint8Array> & {
    readonly isTTY: boolean;
    setRawMode?(mode: boolean): void;
    resume(): void;
    pause(): void;
    on(event: 'data', listener: (chunk: Uint8Array) => void): void;
    removeListener(event: 'data', listener: (chunk: Uint8Array) => void): void;
  };
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
  exitCode?: number;
  exit(code?: number): never;
};

declare module 'node:fs/promises' {
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function writeFile(
    path: string,
    contents: string,
    options: { encoding: 'utf8'; mode?: number },
  ): Promise<void>;
  export function mkdir(path: string, options: { recursive: true }): Promise<void>;
  export function stat(path: string): Promise<unknown>;
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}
declare module 'node:assert/strict' {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    match(value: string, regexp: RegExp, message?: string): void;
    doesNotMatch(value: string, regexp: RegExp, message?: string): void;
  };
  export = assert;
}
