import { parseArgv } from '../args.js';
import type { CommandGroup, Subcommand } from '../commands.js';
import type { Env } from '../env/types.js';
import { EXIT_AUTH, EXIT_FAILURE, EXIT_SUCCESS, UsageError } from '../exit.js';
import { requestWithRetry } from '../http/request.js';
import { publicationBaseUrl } from '../reading/publication.js';
import { loadConfig, saveConfig, type ProfileConfig } from './config.js';
import { availableProfiles, resolveProfile, unwrapCookie, warnIfCookieStale } from './resolve.js';

const addCommand: Subcommand = {
  name: 'add',
  description: 'record a named profile with its publication URL and cookie',
  usage: 'usage: substackctl profile add <name> <publication>',
  async run(argv, env) {
    const parsed = parseArgv(argv, {});
    const [name, publication] = parsed.positionals;
    if (name === undefined) {
      throw new UsageError('missing <name>');
    }
    if (publication === undefined) {
      throw new UsageError('missing <publication>');
    }
    if (parsed.positionals.length > 2) {
      throw new UsageError(`unexpected argument: ${parsed.positionals[2]}`);
    }
    const config = await loadConfig(env);
    if (config.profiles[name] !== undefined) {
      throw new UsageError(
        `profile already exists: ${name}; to refresh its cookie, run: ` +
          `substackctl profile login ${name}`,
      );
    }
    const base = publicationBaseUrl(publication);
    announce(env, 'adding', name, base);
    const cookie = await readCookie(env);
    await saveConfig(env, withProfile(config, name, { publication: base, cookie, cookieSetAt: env.clock() }));
    return EXIT_SUCCESS;
  },
};

const loginCommand: Subcommand = {
  name: 'login',
  description: 're-paste the cookie for an existing profile',
  usage: 'usage: substackctl profile login <name>',
  async run(argv, env) {
    const parsed = parseArgv(argv, {});
    const name = requireName(parsed.positionals);
    const config = await loadConfig(env);
    const stored = config.profiles[name];
    if (stored === undefined) {
      throw new UsageError(`unknown profile: ${name} (${availableProfiles(config)})`);
    }
    announce(env, 'refreshing the cookie for', name, stored.publication);
    const cookie = await readCookie(env);
    await saveConfig(env, withProfile(config, name, { ...stored, cookie, cookieSetAt: env.clock() }));
    return EXIT_SUCCESS;
  },
};

const listCommand: Subcommand = {
  name: 'list',
  description: 'show every profile and mark the default',
  usage: 'usage: substackctl profile list',
  async run(argv, env) {
    const parsed = parseArgv(argv, {});
    if (parsed.positionals.length > 0) {
      throw new UsageError(`unexpected argument: ${parsed.positionals[0]}`);
    }
    const config = await loadConfig(env);
    const names = Object.keys(config.profiles);
    if (names.length === 0) {
      env.stdout.write('no profiles are configured\n');
      return EXIT_SUCCESS;
    }
    const header = ['DEFAULT', 'NAME', 'PUBLICATION'];
    const rows = names.map((name) => [
      config.defaultProfile === name ? '*' : '',
      name,
      config.profiles[name]!.publication,
    ]);
    const widths = header.map((label, column) =>
      Math.max(label.length, ...rows.map((row) => row[column]!.length)),
    );
    const lines = [
      header.map((label, column) => label.padEnd(widths[column]!)).join('  ').trimEnd(),
      ...rows.map((row) =>
        row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd(),
      ),
    ];
    env.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_SUCCESS;
  },
};

const useCommand: Subcommand = {
  name: 'use',
  description: 'set the default profile',
  usage: 'usage: substackctl profile use <name>',
  async run(argv, env) {
    const parsed = parseArgv(argv, {});
    const name = requireName(parsed.positionals);
    const config = await loadConfig(env);
    const stored = config.profiles[name];
    if (stored === undefined) {
      throw new UsageError(`unknown profile: ${name} (${availableProfiles(config)})`);
    }
    announce(env, 'defaulting to', name, stored.publication);
    await saveConfig(env, { ...config, defaultProfile: name });
    return EXIT_SUCCESS;
  },
};

const removeCommand: Subcommand = {
  name: 'remove',
  description: 'delete a profile',
  usage: 'usage: substackctl profile remove <name>',
  async run(argv, env) {
    const parsed = parseArgv(argv, {});
    const name = requireName(parsed.positionals);
    const config = await loadConfig(env);
    const stored = config.profiles[name];
    if (stored === undefined) {
      throw new UsageError(`unknown profile: ${name} (${availableProfiles(config)})`);
    }
    announce(env, 'removing', name, stored.publication);
    const profiles = { ...config.profiles };
    delete profiles[name];
    // Removing the default leaves the default unset; it is never re-assigned.
    const defaultProfile = config.defaultProfile === name ? null : config.defaultProfile;
    await saveConfig(env, { ...config, defaultProfile, profiles });
    return EXIT_SUCCESS;
  },
};

const checkCommand: Subcommand = {
  name: 'check',
  description: 'call the API and report whether the cookie is still valid',
  usage: 'usage: substackctl profile check [name] [--no-retry]',
  async run(argv, env) {
    const parsed = parseArgv(argv, { booleans: ['no-retry'] });
    if (parsed.positionals.length > 1) {
      throw new UsageError(`unexpected argument: ${parsed.positionals[1]}`);
    }
    const config = await loadConfig(env);
    const profile = resolveProfile(env, config, parsed.positionals[0]);
    warnIfCookieStale(env, profile);
    const response = await requestWithRetry(
      env,
      {
        url: `${profile.publication}/api/v1/drafts?limit=1&offset=0`,
        headers: { cookie: `substack.sid=${profile.cookie}` },
      },
      { retry: parsed.values.get('no-retry') !== true },
    );
    const label = `${profile.name ?? 'environment'} (${profile.publication})`;
    if (response.status === 200) {
      env.stdout.write(`${label}: cookie is valid\n`);
      return EXIT_SUCCESS;
    }
    if (response.status === 401 || response.status === 403) {
      env.stderr.write(`${label}: cookie is invalid or expired\n`);
      return EXIT_AUTH;
    }
    env.stderr.write(`${label}: unexpected response (HTTP ${response.status})\n`);
    return EXIT_FAILURE;
  },
};

export const profileGroup: CommandGroup = {
  name: 'profile',
  description: 'manage named publication profiles',
  usage: 'usage: substackctl profile <subcommand> [options]',
  subcommands: [addCommand, loginCommand, listCommand, useCommand, removeCommand, checkCommand],
};

/** Every write command states its profile and publication before acting. */
function announce(env: Env, verb: string, name: string, publication: string): void {
  env.stderr.write(`substackctl: ${verb} profile ${name} (${publication})\n`);
}

function requireName(positionals: string[]): string {
  const [name] = positionals;
  if (name === undefined) {
    throw new UsageError('missing <name>');
  }
  if (positionals.length > 1) {
    throw new UsageError(`unexpected argument: ${positionals[1]}`);
  }
  return name;
}

function withProfile(
  config: ProfileConfig,
  name: string,
  profile: ProfileConfig['profiles'][string],
): ProfileConfig {
  return { ...config, profiles: { ...config.profiles, [name]: profile } };
}

/**
 * Prompts for the cookie and reads it without echoing. Accepts the raw
 * substack.sid value as well as the common pasted variants: surrounding
 * quotes and a leading "substack.sid=", in any order.
 */
async function readCookie(env: Env): Promise<string> {
  env.stderr.write('cookie (substack.sid): ');
  const cookie = unwrapCookie(await env.stdin.readHidden());
  if (cookie === '') {
    throw new Error('cookie must not be empty; paste the substack.sid value from a logged-in browser');
  }
  return cookie;
}

