import type { Env } from '../env/types.js';
import { configDir } from '../profiles/config.js';
import { cliVersion } from '../version.js';

export const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/@tuanhv%2fsub-cli/latest';

/** How long one update check stays fresh: a day per machine, like npm itself. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface CachedCheck {
  checkedAt: number;
  /** The version the registry last reported, or null when the check failed. */
  latest: string | null;
}

function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) {
    throw new Error(`invalid version "${version}"`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compares two x.y.z versions: -1 when left is older, 0 when equal, 1 when newer. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const index of [0, 1, 2] as const) {
    if (a[index]! < b[index]!) {
      return -1;
    }
    if (a[index]! > b[index]!) {
      return 1;
    }
  }
  return 0;
}

/** Reads the newest published version from the npm registry. */
export async function fetchLatestVersion(env: Env): Promise<string> {
  const response = await env.http.request({ url: REGISTRY_LATEST_URL, method: 'GET' });
  if (response.status !== 200) {
    throw new Error(`npm registry returned HTTP ${response.status} for ${REGISTRY_LATEST_URL}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new Error('npm registry response is not valid JSON');
  }
  if (payload === null || typeof payload !== 'object' || !('version' in payload)) {
    throw new Error('npm registry response has no "version" field');
  }
  const { version } = payload;
  if (typeof version !== 'string') {
    throw new Error('npm registry "version" is not a string');
  }
  return version;
}

function updateCheckPath(env: Env): string {
  return `${configDir(env)}/update-check.json`;
}

/** A corrupt or unreadable cache behaves like no cache at all. */
async function readCachedCheck(env: Env): Promise<CachedCheck | null> {
  const path = updateCheckPath(env);
  if (!(await env.fs.exists(path))) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(await env.fs.readFile(path));
    if (parsed === null || typeof parsed !== 'object' || !('checkedAt' in parsed) || !('latest' in parsed)) {
      return null;
    }
    const { checkedAt, latest } = parsed;
    if (typeof checkedAt !== 'number' || !(latest === null || typeof latest === 'string')) {
      return null;
    }
    return { checkedAt, latest };
  } catch {
    return null;
  }
}

async function writeCachedCheck(env: Env, latest: string | null): Promise<void> {
  const cache: CachedCheck = { checkedAt: env.clock(), latest };
  await env.fs.mkdir(configDir(env));
  await env.fs.writeFile(updateCheckPath(env), `${JSON.stringify(cache)}\n`, { mode: 0o600 });
}

/**
 * Records a check result for the next day. Best-effort: the cache only
 * exists to keep the warning quiet, so a failed write is ignored and just
 * costs one extra registry request next time.
 */
export async function recordUpdateCheck(env: Env, latest: string | null): Promise<void> {
  try {
    await writeCachedCheck(env, latest);
  } catch {
    // Ignored on purpose; see above.
  }
}

/**
 * Prints a one-line notice on stderr when a newer release exists. Every
 * failure (offline, registry trouble, cache trouble) stays silent so this
 * can never break the command it follows. Set SUB_CLI_NO_UPDATE_CHECK
 * to skip the check entirely.
 */
export async function warnIfUpdateAvailable(env: Env): Promise<void> {
  if ((env.vars['SUB_CLI_NO_UPDATE_CHECK'] ?? '') !== '') {
    return;
  }
  try {
    let latest: string | null;
    const cached = await readCachedCheck(env);
    if (cached !== null && env.clock() - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS) {
      latest = cached.latest;
    } else {
      try {
        latest = await fetchLatestVersion(env);
      } catch {
        // Record the miss so an offline machine retries tomorrow, not on
        // every command.
        latest = null;
      }
      await recordUpdateCheck(env, latest);
    }
    if (latest !== null && compareVersions(latest, cliVersion()) > 0) {
      env.stderr.write(`sub-cli ${latest} is available; run "sub-cli update" to upgrade\n`);
    }
  } catch {
    // A background convenience must never surface as a command failure.
  }
}
