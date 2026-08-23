import { parseArgv } from '../args.js';
import type { Subcommand } from '../commands.js';
import type { Env } from '../env/types.js';
import { EXIT_AUTH, EXIT_FAILURE, EXIT_SUCCESS, UsageError } from '../exit.js';
import { loadConfig } from '../profiles/config.js';
import { resolveProfile, warnIfCookieStale } from '../profiles/resolve.js';
import { AuthError, SubstackClient } from './api.js';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const updateUsage =
  'usage: substackctl post update <id> [--section <name>] [--subtitle <s>] [--slug <slug>] [--profile <name>]';

export const updateCommand: Subcommand = {
  name: 'update',
  description: "change a single post's section, subtitle, or custom slug in one request",
  usage: updateUsage,
  async run(argv, env) {
    const parsed = parseArgv(argv, {
      strings: ['section', 'subtitle', 'slug', 'profile'],
      booleans: [],
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
    const patch: Record<string, string> = {};
    const flag = (name: string): string | undefined => {
      const value = parsed.values.get(name);
      return typeof value === 'string' ? value : undefined;
    };
    const section = flag('section');
    const subtitle = flag('subtitle');
    const slug = flag('slug');
    if (section === undefined && subtitle === undefined && slug === undefined) {
      throw new UsageError('nothing to update: pass --section, --subtitle, or --slug');
    }
    if (slug !== undefined && !SLUG.test(slug)) {
      throw new UsageError(`invalid slug "${slug}": use lowercase words separated by single hyphens`);
    }
    const config = await loadConfig(env);
    const profileName = flag('profile');
    const profile = resolveProfile(env, config, profileName);
    warnIfCookieStale(env, profile);
    env.stderr.write(
      `substackctl: updating post ${id} on profile ${profile.name ?? 'environment'} (${profile.publication})\n`,
    );
    const client = new SubstackClient(env, profile.publication, profile.cookie);
    try {
      let sectionId: number | undefined;
      if (section !== undefined) {
        const sections = await client.listSections();
        const match = sections.find((entry) => entry.name === section || entry.slug === section);
        if (match === undefined) {
          const available = sections.length === 0
            ? 'the publication has no sections'
            : `available sections: ${sections.map((entry) => entry.name).join(', ')}`;
          throw new UsageError(`unknown section "${section}" (${available})`);
        }
        sectionId = match.id;
      }
      // Every requested field rides one PUT; the API applies the patch
      // atomically and leaves unspecified fields alone.
      const requestBody: Record<string, string | number> = {};
      if (subtitle !== undefined) {
        requestBody['draft_subtitle'] = subtitle;
      }
      if (slug !== undefined) {
        requestBody['slug'] = slug;
      }
      if (sectionId !== undefined) {
        requestBody['draft_section_id'] = sectionId;
      }
      await client.updateDraft(id, requestBody);
      const fields = await client.draftFields(id);
      if (sectionId !== undefined && fields.draft_section_id !== sectionId) {
        env.stderr.write(`substackctl: post ${id}: section did not stick (draft_section_id is empty)\n`);
        return EXIT_FAILURE;
      }
      env.stdout.write(`updated ${id}\n`);
      const finalSlug = slug ?? fields.slug;
      if (finalSlug !== null) {
        env.stdout.write(`url: ${profile.publication}/p/${finalSlug}\n`);
      }
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
