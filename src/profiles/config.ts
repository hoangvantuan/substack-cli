import type { Env } from '../env/types.js';

/** The only configuration layout this version of the tool understands. */
export const SCHEMA_VERSION = 1;

/** Written whenever a file is created, so cookies stay owner-readable only. */
const OWNER_READ_ONLY = 0o600;

export interface StoredProfile {
  /** Publication base URL, always https with no path. */
  publication: string;
  /** The substack.sid value authenticating every authoring command. */
  cookie: string;
  /** Epoch milliseconds of the moment the cookie was last set. */
  cookieSetAt: number;
}

/** The whole configuration file as a single JSON document. */
export interface ProfileConfig {
  schemaVersion: number;
  defaultProfile: string | null;
  profiles: Record<string, StoredProfile>;
}

export function emptyConfig(): ProfileConfig {
  return { schemaVersion: SCHEMA_VERSION, defaultProfile: null, profiles: {} };
}

/** The directory holding the configuration, under the standard config root. */
export function configDir(env: Env): string {
  const root = env.vars['XDG_CONFIG_HOME'] ?? `${env.homedir()}/.config`;
  return `${root}/substackctl`;
}

export function configPath(env: Env): string {
  return `${configDir(env)}/config.json`;
}

export async function loadConfig(env: Env): Promise<ProfileConfig> {
  const path = configPath(env);
  if (!(await env.fs.exists(path))) {
    return emptyConfig();
  }
  const text = await env.fs.readFile(path);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`configuration file is not valid JSON: ${path}`);
  }
  return parseConfig(raw, path);
}

export async function saveConfig(env: Env, config: ProfileConfig): Promise<void> {
  await env.fs.mkdir(configDir(env));
  await env.fs.writeFile(configPath(env), `${JSON.stringify(config, null, 2)}\n`, {
    mode: OWNER_READ_ONLY,
  });
}

function parseConfig(raw: unknown, path: string): ProfileConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`configuration file is not valid: ${path}`);
  }
  const record = raw as Record<string, unknown>;
  if (record['schemaVersion'] !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported configuration schema version ${String(record['schemaVersion'])}: ${path}`,
    );
  }
  const defaultProfile = record['defaultProfile'];
  if (typeof defaultProfile !== 'string' && defaultProfile !== null) {
    throw new Error(`configuration file is not valid: ${path}`);
  }
  const profilesRaw = record['profiles'];
  if (typeof profilesRaw !== 'object' || profilesRaw === null || Array.isArray(profilesRaw)) {
    throw new Error(`configuration file is not valid: ${path}`);
  }
  const profiles: Record<string, StoredProfile> = {};
  for (const [name, entry] of Object.entries(profilesRaw)) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`configuration file is not valid: ${path}`);
    }
    const fields = entry as Record<string, unknown>;
    if (
      typeof fields['publication'] !== 'string' ||
      typeof fields['cookie'] !== 'string' ||
      typeof fields['cookieSetAt'] !== 'number'
    ) {
      throw new Error(`configuration file is not valid: ${path}`);
    }
    profiles[name] = {
      publication: fields['publication'],
      cookie: fields['cookie'],
      cookieSetAt: fields['cookieSetAt'],
    };
  }
  return { schemaVersion: SCHEMA_VERSION, defaultProfile, profiles };
}
