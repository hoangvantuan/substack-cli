import { readFileSync } from 'node:fs';

/**
 * Shared credentials loader for the integration suites. This module must
 * stay test-free: importing authoring.test.ts from a sibling suite would
 * register its tests a second time.
 */

const BIN = new URL('../../../dist/bin/sub-cli.js', import.meta.url);
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

export interface IntegrationResponse {
  status: number;
  json: unknown;
}

const REAL_WAIT_MS = [1000, 2000, 4000, 8000, 8000];

/**
 * The one HTTP helper every integration suite shares. It retries rate
 * limiting with a real backoff: these suites exercise the platform's live
 * limiter, which no in-test fake clock can stand in for.
 */
export async function integrationApi(method: string, path: string, body?: unknown): Promise<IntegrationResponse> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          cookie: `substack.sid=${COOKIE}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (attempt >= REAL_WAIT_MS.length) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, REAL_WAIT_MS[attempt]));
      continue;
    }
    const text = await response.text();
    let json: unknown = null;
    if (text !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    if (response.status === 429 && attempt < REAL_WAIT_MS.length) {
      await new Promise((resolve) => setTimeout(resolve, REAL_WAIT_MS[attempt]));
      continue;
    }
    return { status: response.status, json };
  }
}
