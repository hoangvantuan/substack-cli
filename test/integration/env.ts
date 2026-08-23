import { readFileSync } from 'node:fs';

/**
 * Shared credentials loader for the integration suites. This module must
 * stay test-free: importing authoring.test.ts from a sibling suite would
 * register its tests a second time.
 */

const BIN = new URL('../../../dist/bin/substackctl.js', import.meta.url);
export { BIN };

function loadDotEnv(): Record<string, string> {
  const candidates = [
    // Inside the main checkout this is <repo>/.env; inside a linked
    // worktree it walks up to the main repository.
    '../../../../../.env',
    '../../../.env',
    '.env',
  ];
  const values: Record<string, string> = {};
  for (const candidate of candidates) {
    try {
      const text = readFileSync(new URL(candidate, import.meta.url), 'utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#') || !trimmed.includes('=')) {
          continue;
        }
        const [key, ...rest] = trimmed.split('=');
        values[key!.trim()] = rest.join('=').trim();
      }
      break;
    } catch {
      // Try the next candidate.
    }
  }
  return values;
}

const dotenv = loadDotEnv();

export const BASE_URL = (process.env['SUBSTACK_PUBLICATION_URL'] ?? dotenv['SUBSTACK_PUBLICATION_URL'] ?? '').replace(/\/$/, '');
export const COOKIE = process.env['SUBSTACK_COOKIE'] ?? dotenv['SUBSTACK_COOKIE'] ?? '';
export const hasCredentials = BASE_URL !== '' && COOKIE !== '';
export const credentialsHint = 'set SUBSTACK_COOKIE and SUBSTACK_PUBLICATION_URL (see .env) to run the integration suite';
