import { UsageError } from '../exit.js';

/**
 * Normalises a publication reference, given as a slug, a full URL, or a
 * domain, into the publication base URL (always https, no path).
 */
export function publicationBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new UsageError('publication must not be empty');
  }
  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : trimmed.includes('.')
      ? `https://${trimmed}`
      : `https://${trimmed}.substack.com`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new UsageError(`invalid publication: ${input}`);
  }
  return `https://${url.hostname}`;
}
