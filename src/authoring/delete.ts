import { parseArgv } from '../args.js';
import type { Subcommand } from '../commands.js';
import type { Env } from '../env/types.js';
import { EXIT_AUTH, EXIT_FAILURE, EXIT_SUCCESS, UsageError } from '../exit.js';
import { loadConfig } from '../profiles/config.js';
import { resolveProfile, warnIfCookieStale } from '../profiles/resolve.js';
import { AuthError, SubstackClient } from './api.js';

export const deleteUsage =
  'usage: sub-cli post delete <id> --yes [--force-published] [--profile <name>]';

export const deleteCommand: Subcommand = {
  name: 'delete',
  description: "delete a draft or scheduled post; a published post also needs --force-published",
  usage: deleteUsage,
  async run(argv, env) {
    const parsed = parseArgv(argv, {
      booleans: ['yes', 'force-published'],
      strings: ['profile'],
    });
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
    if (parsed.values.get('yes') !== true) {
      throw new UsageError('refusing to delete without --yes; deletion cannot be undone');
    }
    const config = await loadConfig(env);
    const profileName = typeof parsed.values.get('profile') === 'string'
      ? (parsed.values.get('profile') as string)
      : undefined;
    const profile = resolveProfile(env, config, profileName);
    warnIfCookieStale(env, profile);
    const forcePublished = parsed.values.get('force-published') === true;
    env.stderr.write(
      `sub-cli: deleting post ${id} on profile ${profile.name ?? 'environment'} (${profile.publication})\n`,
    );
    const client = new SubstackClient(env, profile.publication, profile.cookie);
    try {
      // The state comes from the API, never from the arguments: the id says
      // nothing about whether the post already went out to subscribers.
      const state = await client.draftState(id);
      if (state.published && !forcePublished) {
        env.stderr.write(
          `sub-cli: post ${id} is published and cannot be recalled; ` +
            `deleting it also removes it for every subscriber. ` +
            `Pass --force-published to delete it anyway\n`,
        );
        return EXIT_FAILURE;
      }
      await client.deleteDraft(id);
      env.stdout.write(`deleted ${id}\n`);
      return EXIT_SUCCESS;
    } catch (error) {
      if (error instanceof AuthError) {
        env.stderr.write(`sub-cli: ${error.message}\n`);
        return EXIT_AUTH;
      }
      throw error;
    }
  },
};
