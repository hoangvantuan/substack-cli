import { readFileSync } from 'node:fs';

/**
 * The CLI's own version. Read from the package.json that ships next to the
 * compiled output, so `npm version` bumps flow through without a second
 * copy of the number drifting inside the source tree.
 */
export function cliVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  if (manifest === null || typeof manifest !== 'object' || !('version' in manifest)) {
    throw new Error('package.json has no "version" field');
  }
  const { version } = manifest;
  if (typeof version !== 'string') {
    throw new Error('package.json "version" is not a string');
  }
  return version;
}
