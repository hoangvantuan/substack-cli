import { parseArgv } from '../args.js';
import { parsePostFile } from '../conversion/frontmatter.js';
import { convertMarkdownToDocument } from '../conversion/markdown.js';
import { validateDocument } from '../conversion/schema.js';
import type { Subcommand } from '../commands.js';
import type { Env } from '../env/types.js';
import { EXIT_AUTH, EXIT_SUCCESS, UsageError } from '../exit.js';
import { loadConfig } from '../profiles/config.js';
import { resolveProfile, warnIfCookieStale } from '../profiles/resolve.js';
import { AuthError, SubstackClient } from './api.js';

export const publishUsage =
  'usage: substackctl post publish <file> --profile <name> --yes [--no-send] [--audience <a>]\n' +
  '       substackctl post publish --id <identifier> --profile <name> --yes [--no-send] [--audience <a>]';

const AUDIENCES: Record<string, true> = { everyone: true, only_paid: true, only_free: true, founding: true };

export const publishCommand: Subcommand = {
  name: 'publish',
  description: 'create a post from a Markdown file or take an existing draft public; cannot be undone',
  usage: publishUsage,
  async run(argv, env) {
    const parsed = parseArgv(argv, {
      strings: ['profile', 'audience', 'id'],
      booleans: ['yes', 'no-send'],
    });
    const flag = (name: string): string | undefined => {
      const value = parsed.values.get(name);
      return typeof value === 'string' ? value : undefined;
    };
    const file = parsed.positionals[0];
    if (parsed.positionals.length > 1) {
      throw new UsageError(`unexpected argument: ${parsed.positionals[1]}`);
    }
    const idValue = flag('id');
    if (idValue !== undefined && !/^\d+$/.test(idValue)) {
      throw new UsageError(`invalid --id "${idValue}": expected a numeric identifier`);
    }
    const id = idValue === undefined ? undefined : Number(idValue);
    if ((file === undefined) === (id === undefined)) {
      throw new UsageError('choose exactly one source: a Markdown <file>, or an existing draft with --id');
    }
    // ADR-0004: publishing is the one irreversible action, so it ignores the
    // default profile and the sole-profile shortcut. Only an explicit
    // --profile (or the two environment variables, which name the publication
    // and the cookie directly) plus an explicit --yes unlock it.
    const missing: string[] = [];
    const hasEnvProfile =
      env.vars['SUBSTACK_PUBLICATION_URL'] !== undefined &&
      env.vars['SUBSTACK_PUBLICATION_URL'] !== '' &&
      env.vars['SUBSTACK_COOKIE'] !== undefined &&
      env.vars['SUBSTACK_COOKIE'] !== '';
    if (flag('profile') === undefined && !hasEnvProfile) {
      missing.push('--profile <name>');
    }
    if (parsed.values.get('yes') !== true) {
      missing.push('--yes');
    }
    if (missing.length > 0) {
      throw new UsageError(
        `refusing to publish: publishing cannot be undone, pass ${missing.join(' and ')} to confirm`,
      );
    }
    let prepared:
      | { title: string; subtitle: string; body: string; audience: string }
      | undefined;
    if (file !== undefined) {
      let contents: string;
      try {
        contents = await env.fs.readFile(file);
      } catch (error) {
        throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const post = parsePostFile(contents);
      for (const key of post.unknownFields) {
        env.stderr.write(`warning: ignoring unknown front matter field: ${key}\n`);
      }
      // The create command's slug, section, and cover need their own steps;
      // prepare those with `post create` and publish with --id instead of
      // dropping them silently here.
      for (const key of ['slug', 'section', 'cover'] as const) {
        if (post.fields[key] !== undefined) {
          env.stderr.write(
            `warning: ignoring front matter field ${key}: prepare it with "post create", then publish with --id\n`,
          );
        }
      }
      const title = post.fields['title'];
      if (title === undefined || title === '') {
        throw new Error('missing title: set "title" in the front matter');
      }
      const audience = flag('audience') ?? post.fields['audience'] ?? 'everyone';
      if (!(audience in AUDIENCES)) {
        throw new Error(`invalid audience "${audience}": expected everyone, only_paid, only_free, or founding`);
      }
      const { document, warnings } = convertMarkdownToDocument(post.body);
      for (const warning of warnings) {
        env.stderr.write(`warning: ${warning}\n`);
      }
      const violations = validateDocument(document);
      if (violations.length > 0) {
        throw new Error(`document failed local schema validation: ${violations[0]}`);
      }
      prepared = { title, subtitle: post.fields['subtitle'] ?? '', body: JSON.stringify(document), audience };
    } else if (flag('audience') !== undefined && !(flag('audience')! in AUDIENCES)) {
      throw new Error(`invalid audience "${flag('audience')}": expected everyone, only_paid, only_free, or founding`);
    }
    const config = await loadConfig(env);
    const profile = resolveProfile(env, config, flag('profile'));
    warnIfCookieStale(env, profile);
    env.stderr.write(
      `substackctl: publishing on profile ${profile.name ?? 'environment'} (${profile.publication}); this cannot be undone\n`,
    );
    const client = new SubstackClient(env, profile.publication, profile.cookie);
    try {
      let draftId: number;
      if (prepared !== undefined) {
        const bylineUserId = await client.ownerUserId();
        const draft = await client.createDraft({
          title: prepared.title,
          subtitle: prepared.subtitle,
          body: prepared.body,
          bylineUserId,
          audience: prepared.audience,
        });
        draftId = draft.id;
      } else {
        const existing = await client.getDraft(id!);
        draftId = existing.id;
        const audience = flag('audience');
        if (audience !== undefined) {
          await client.updateDraft(draftId, { audience });
        }
      }
      await runPrepublishCheck(client, draftId, env);
      const published = await client.publishDraft(draftId, {
        sendEmail: parsed.values.get('no-send') !== true,
      });
      env.stdout.write(`published ${published.id}\n`);
      if (published.slug !== null) {
        env.stdout.write(`url: ${profile.publication}/p/${published.slug}\n`);
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

/**
 * Runs the pre-publish check. The endpoint is flaky, and the specification is
 * explicit that its failure must never block publishing: any failure or error
 * entry is logged on stderr and the publish proceeds regardless. A publish
 * that truly cannot go out still fails loudly in the publish call itself.
 */
async function runPrepublishCheck(client: SubstackClient, draftId: number, env: Env): Promise<void> {
  let result: { errors: unknown[]; suggestions: unknown[] };
  try {
    result = await client.prepublishCheck(draftId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    env.stderr.write(`warning: pre-publish check failed (${message}); continuing\n`);
    return;
  }
  for (const item of [...result.errors, ...result.suggestions]) {
    env.stderr.write(`warning: pre-publish check reported ${JSON.stringify(item)}; continuing\n`);
  }
}
