import type { Env, HttpRequest, HttpResponse } from '../env/types.js';
import { RateLimitedError } from '../exit.js';

/** Fixed increasing waits used when the server states no delay of its own. */
export const RETRY_LADDER_MS: readonly number[] = [1000, 2000, 4000, 8000];

export interface RequestOptions {
  /** When false, a rate-limited request fails immediately instead of retrying. */
  retry?: boolean;
}

/**
 * Performs a request, retrying 429 responses. The server-stated Retry-After
 * delay wins when present; the fixed ladder is the fallback. Progress goes to
 * stderr so stdout stays clean for structured output.
 */
export async function requestWithRetry(
  env: Env,
  request: HttpRequest,
  options: RequestOptions = {},
): Promise<HttpResponse> {
  const maxRetries = options.retry === false ? 0 : RETRY_LADDER_MS.length;
  let attempt = 0;
  for (;;) {
    const response = await env.http.request(request);
    if (response.status !== 429) {
      return response;
    }
    if (attempt >= maxRetries) {
      const attempts = attempt + 1;
      throw new RateLimitedError(
        `rate limited; giving up after ${attempts} attempt${attempts === 1 ? '' : 's'}`,
      );
    }
    const delay = delayFor(response, attempt, env.clock());
    env.stderr.write(
      `substackctl: rate limited; retry ${attempt + 1} of ${maxRetries} after ${delay}ms\n`,
    );
    await env.sleep(delay);
    attempt += 1;
  }
}

function delayFor(response: HttpResponse, attempt: number, now: number): number {
  const stated = retryAfterMs(response.headers, now);
  if (stated !== null) {
    return stated;
  }
  return RETRY_LADDER_MS[Math.min(attempt, RETRY_LADDER_MS.length - 1)]!;
}

/**
 * Reads Retry-After: an integer number of seconds, or an HTTP date. Returns
 * null when absent or unintelligible.
 */
function retryAfterMs(headers: Record<string, string>, now: number): number | null {
  let raw: string | undefined;
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'retry-after') {
      raw = headers[name];
      break;
    }
  }
  if (raw === undefined) {
    return null;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && raw.trim() !== '') {
    return Math.max(0, Math.ceil(seconds * 1000));
  }
  const until = Date.parse(raw);
  if (!Number.isNaN(until)) {
    return Math.max(0, until - now);
  }
  return null;
}
