/** Exit codes shared by every command. */
export const EXIT_SUCCESS = 0;
/** General failure: network error, server error, malformed response. */
export const EXIT_FAILURE = 1;
/** The command line itself is wrong. */
export const EXIT_USAGE = 2;
/** Reserved for authentication failures (not used by unauthenticated commands). */
export const EXIT_AUTH = 3;
/** Rate limited: retries exhausted (or disabled) while the server kept saying 429. */
export const EXIT_RATE_LIMIT = 4;

/** Thrown when the command line is wrong; mapped to EXIT_USAGE. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Thrown when rate-limit retries are exhausted; mapped to EXIT_RATE_LIMIT. */
export class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitedError';
  }
}
