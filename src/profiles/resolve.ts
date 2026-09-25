import type { Env } from '../env/types.js';
import { UsageError } from '../exit.js';
import { publicationBaseUrl } from '../reading/publication.js';
import type { ProfileConfig } from './config.js';

/**
 * Cookies older than this are warned about before the command runs: Substack
 * cookies expire after one to two weeks.
 */
export const COOKIE_STALE_MS = 10 * 24 * 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The profile a command acts on. Later issues decide their publication by
 * calling resolveProfile, never by reading the configuration directly.
 */
export interface ResolvedProfile {
  /** Null when the two environment variables stood in for a stored profile. */
  name: string | null;
  publication: string;
  cookie: string;
  /** Null when the age of the cookie is unknown (environment override). */
  cookieSetAt: number | null;
}

/**
 * Resolution order: environment variables, then the explicitly named
 * profile, then the default profile, then the sole profile when exactly one
 * exists, then failure listing the available profiles.
 */
export function resolveProfile(
  env: Env,
  config: ProfileConfig,
  explicitName?: string,
): ResolvedProfile {
  if (hasEnvironmentProfile(env)) {
    return {
      name: null,
      publication: publicationBaseUrl(env.vars['SUBSTACK_PUBLICATION_URL']!),
      cookie: unwrapCookie(env.vars['SUBSTACK_COOKIE']!),
      cookieSetAt: null,
    };
  }
  if (explicitName !== undefined) {
    const stored = config.profiles[explicitName];
    if (stored === undefined) {
      throw new UsageError(`unknown profile: ${explicitName} (${availableProfiles(config)})`);
    }
    return { name: explicitName, ...stored };
  }
  const defaultName = config.defaultProfile;
  if (defaultName !== null && config.profiles[defaultName] !== undefined) {
    return { name: defaultName, ...config.profiles[defaultName]! };
  }
  const names = Object.keys(config.profiles);
  if (names.length === 1) {
    const sole = names[0]!;
    return { name: sole, ...config.profiles[sole]! };
  }
  throw new UsageError(
    names.length === 0
      ? `no profile to act on (${availableProfiles(config)})`
      : `no profile given and no default profile is set (${availableProfiles(config)})`,
  );
}

/**
 * True when the two environment variables name the publication and the
 * cookie directly. They stand in for an explicit --profile, which is what
 * lets the commands guarded by ADR 0004 accept them.
 */
export function hasEnvironmentProfile(env: Env): boolean {
  const publication = env.vars['SUBSTACK_PUBLICATION_URL'];
  const cookie = env.vars['SUBSTACK_COOKIE'];
  return publication !== undefined && publication !== '' && cookie !== undefined && cookie !== '';
}

/** Warns on the error stream when the cookie may soon be expired. */
export function warnIfCookieStale(env: Env, profile: ResolvedProfile): void {
  if (profile.cookieSetAt === null) {
    return;
  }
  const age = env.clock() - profile.cookieSetAt;
  if (age <= COOKIE_STALE_MS) {
    return;
  }
  const name = profile.name ?? 'this profile';
  env.stderr.write(
    `sub-cli: warning: the cookie for ${name} is ${Math.floor(age / MS_PER_DAY)} days old ` +
      `and Substack cookies expire after one to two weeks; ` +
      `refresh it with: sub-cli profile login ${name}\n`,
  );
}

/**
 * Normalises a pasted cookie: trims whitespace, sheds surrounding quotes and
 * a leading "substack.sid=" in any order, so the raw value, the pasted
 * "name=value" form, and quoted variants all authenticate.
 */
export function unwrapCookie(pasted: string): string {
  let value = pasted.trim();
  for (;;) {
    const first = value[0];
    const unquoted =
      value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)
        ? value.slice(1, -1)
        : value;
    const withoutPrefix = unquoted.startsWith('substack.sid=')
      ? unquoted.slice('substack.sid='.length)
      : unquoted;
    if (withoutPrefix === value) {
      return value;
    }
    value = withoutPrefix;
  }
}

export function availableProfiles(config: ProfileConfig): string {
  const names = Object.keys(config.profiles);
  if (names.length === 0) {
    return 'no profiles are configured; add one with: sub-cli profile add <name> <publication>';
  }
  return `available profiles: ${names.join(', ')}`;
}
