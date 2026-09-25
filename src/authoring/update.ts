import { parseArgv } from '../args.js';
import type { Subcommand } from '../commands.js';
import { EXIT_AUTH, EXIT_FAILURE, EXIT_SUCCESS, UsageError } from '../exit.js';
import { loadConfig } from '../profiles/config.js';
import { resolveProfile, warnIfCookieStale } from '../profiles/resolve.js';
import { AuthError, SubstackClient } from './api.js';
import { draftPatch, isEmptyChange, prepareChange, readPostChange, warnLocalImages } from './content.js';

export const updateUsage =
  'usage: sub-cli post update <id> [--file <path>] [--section <name>] [--subtitle <s>] [--slug <slug>]\n' +
  '                                [--cover <url>] [--profile <name>] [--dry-run]';

export const updateCommand: Subcommand = {
  name: 'update',
  description: "change a draft or scheduled post's content (from a file), section, subtitle, cover, or slug",
  usage: updateUsage,
  async run(argv, env) {
    const parsed = parseArgv(argv, {
      strings: ['file', 'section', 'subtitle', 'slug', 'cover', 'profile'],
      booleans: ['dry-run'],
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
    const flag = (name: string): string | undefined => {
      const value = parsed.values.get(name);
      return typeof value === 'string' ? value : undefined;
    };
    const file = flag('file');
    const change = await readPostChange(env, file, {
      subtitle: flag('subtitle'),
      cover: flag('cover'),
      section: flag('section'),
      slug: flag('slug'),
    });
    if (isEmptyChange(change)) {
      throw new UsageError('nothing to update: pass --file, --section, --subtitle, --cover, or --slug');
    }
    const config = await loadConfig(env);
    const profile = resolveProfile(env, config, flag('profile'));
    warnIfCookieStale(env, profile);
    env.stderr.write(
      `sub-cli: ${parsed.values.get('dry-run') === true ? 'previewing an update of' : 'updating'} post ${id} on profile ${profile.name ?? 'environment'} (${profile.publication})\n`,
    );
    const client = new SubstackClient(env, profile.publication, profile.cookie);
    try {
      // The state comes from the API before anything is uploaded or written.
      // On a published post the subtitle, body, and section land in staged
      // fields that never go live while a slug goes live at once, so the edit
      // belongs to `post revise` (ADR 0006).
      const state = await client.draftState(id);
      if (state.published) {
        env.stderr.write(
          `sub-cli: post ${id} is published; post update changes drafts and scheduled posts only. ` +
            `To change a published post, use: sub-cli post revise ${id}\n`,
        );
        return EXIT_FAILURE;
      }
      if (parsed.values.get('dry-run') === true) {
        // The state read above is the only request a dry run sends, so the
        // preview never shows a request the real run would refuse.
        warnLocalImages(env, change);
        const request: Record<string, unknown> = { method: 'PUT', url: `/api/v1/drafts/${id}`, body: draftPatch(change) };
        if (change.section !== undefined) {
          request['section'] = change.section;
        }
        env.stdout.write(JSON.stringify(request, null, 2) + '\n');
        return EXIT_SUCCESS;
      }
      const sectionId = await prepareChange(env, client, change);
      // Content and metadata ride one PUT; the API leaves unnamed fields alone.
      await client.updateDraft(id, draftPatch(change, sectionId));
      const fields = await client.draftFields(id);
      if (sectionId !== undefined && fields.draft_section_id !== sectionId) {
        env.stderr.write(`sub-cli: post ${id}: section did not stick (draft_section_id is empty)\n`);
        return EXIT_FAILURE;
      }
      env.stdout.write(`updated ${id}\n`);
      const finalSlug = change.slug ?? fields.slug;
      if (finalSlug !== null) {
        env.stdout.write(`url: ${profile.publication}/p/${finalSlug}\n`);
      }
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
