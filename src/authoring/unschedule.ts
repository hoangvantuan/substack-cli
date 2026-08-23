import { parseArgv } from '../args.js';
import type { Subcommand } from '../commands.js';
import type { Env } from '../env/types.js';
import { EXIT_AUTH, EXIT_FAILURE, EXIT_SUCCESS, UsageError } from '../exit.js';
import { loadConfig } from '../profiles/config.js';
import { resolveProfile, warnIfCookieStale } from '../profiles/resolve.js';
import { AuthError, SubstackClient } from './api.js';

export const unscheduleUsage =
  'usage: substackctl post unschedule <id> [--profile <name>]';

export const unscheduleCommand: Subcommand = {
  name: 'unschedule',
  description: 'remove a scheduled release; the post returns to being a draft',
  usage: unscheduleUsage,
  async run(argv, env) {
    const parsed = parseArgv(argv, { strings: ['profile'] });
    const idRaw = parsed.positionals[0];
    if (idRaw === undefined) {
      throw new UsageError('missing <id>');
    }
    if (parsed.positionals.length > 1) {
      throw new UsageError(`unexpected argument: ${parsed.positionals[1]}`);
    }
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id < 1) {
      throw new UsageError(`<id> must be a positive integer: ${idRaw}`);
    }
    const config = await loadConfig(env);
    const profileName = typeof parsed.values.get('profile') === 'string'
      ? (parsed.values.get('profile') as string)
      : undefined;
    const profile = resolveProfile(env, config, profileName);
    warnIfCookieStale(env, profile);
    env.stderr.write(
      `substackctl: unscheduling post ${id} on profile ${profile.name ?? 'environment'} (${profile.publication})\n`,
    );
    const client = new SubstackClient(env, profile.publication, profile.cookie);
    try {
      // The state comes from the API: a published post has no schedule to
      // remove, and the arguments say nothing about whether one exists.
      const state = await client.draftState(id);
      if (state.published) {
        env.stderr.write(
          `substackctl: post ${id} is published; there is no scheduled release to remove\n`,
        );
        return EXIT_FAILURE;
      }
      const active = await client.getScheduledRelease(id);
      if (active.length === 0) {
        env.stderr.write(`substackctl: post ${id} is not scheduled\n`);
        return EXIT_FAILURE;
      }
      await client.unscheduleRelease(id);
      // Read back: an unremoved schedule would silently publish later.
      const remaining = await client.getScheduledRelease(id);
      if (remaining.length > 0) {
        throw new Error(`post ${id} still lists a scheduled release after removing it`);
      }
      env.stdout.write(`unscheduled ${id}\n`);
      return EXIT_SUCCESS;
    } catch (error) {
      if (error instanceof AuthError) {
        env.stderr.write(`substackctl: ${error.message}\n`);
        return EXIT_AUTH;
      }
      throw error;
    }
  },
};
