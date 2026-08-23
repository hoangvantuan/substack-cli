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

export const scheduleUsage =
  'usage: substackctl post schedule <file> <time> [--audience <a>] [--profile <name>]\n' +
  '       <time> is ISO 8601: 2026-12-24T09:30 or 2026-12-24 09:30 means\n' +
  '       machine-local time; 2026-12-24T09:30+07:00 or ...Z is used as given';

const AUDIENCES: Record<string, true> = { everyone: true, only_paid: true, only_free: true, founding: true };

/**
 * Reads a release time in one of the accepted ISO 8601 shapes. A time
 * without a timezone is interpreted in the machine's local time; a time
 * carrying `Z` or a numeric offset is used exactly as given.
 */
export function parseReleaseTime(input: string): Date {
  const text = input.trim();
  const hasTimezone = /(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(text);
  let when: Date;
  if (hasTimezone) {
    when = new Date(text.replace(' ', 'T'));
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
    if (match === null) {
      throw new UsageError(
        `cannot understand release time "${input}"; ` +
          'use an ISO 8601 time such as 2026-12-24T09:30 or 2026-12-24T09:30+07:00',
      );
    }
    when = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4] ?? '0'),
      Number(match[5] ?? '0'),
      Number(match[6] ?? '0'),
    );
  }
  if (Number.isNaN(when.getTime())) {
    throw new UsageError(`cannot understand release time "${input}"`);
  }
  return when;
}

export const scheduleCommand: Subcommand = {
  name: 'schedule',
  description: 'create a draft and set its future release time in one command',
  usage: scheduleUsage,
  async run(argv, env) {
    const parsed = parseArgv(argv, { strings: ['audience', 'profile'] });
    const file = parsed.positionals[0];
    if (file === undefined) {
      throw new UsageError('missing <file>');
    }
    const timeInput = parsed.positionals[1];
    if (timeInput === undefined) {
      throw new UsageError('missing <time>');
    }
    if (parsed.positionals.length > 2) {
      throw new UsageError(`unexpected argument: ${parsed.positionals[2]}`);
    }
    const flag = (name: string): string | undefined => {
      const value = parsed.values.get(name);
      return typeof value === 'string' ? value : undefined;
    };
    const audience = flag('audience') ?? 'everyone';
    if (!(audience in AUDIENCES)) {
      throw new Error(`invalid audience "${audience}": expected everyone, only_paid, only_free, or founding`);
    }
    const when = parseReleaseTime(timeInput);
    if (when.getTime() <= env.clock()) {
      throw new Error(
        `release time ${when.toISOString()} is not in the future; ` +
          'scheduling a past time would release the post immediately',
      );
    }
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
    const title = post.fields['title'];
    if (title === undefined || title === '') {
      throw new Error('missing title: set "title" in the front matter');
    }
    const subtitle = post.fields['subtitle'] ?? '';
    const { document, warnings } = convertMarkdownToDocument(post.body);
    for (const warning of warnings) {
      env.stderr.write(`warning: ${warning}\n`);
    }
    const violations = validateDocument(document);
    if (violations.length > 0) {
      throw new Error(`document failed local schema validation: ${violations[0]}`);
    }
    const config = await loadConfig(env);
    const profile = resolveProfile(env, config, flag('profile'));
    warnIfCookieStale(env, profile);
    env.stderr.write(
      `substackctl: scheduling a post on profile ${profile.name ?? 'environment'} (${profile.publication})\n`,
    );
    const client = new SubstackClient(env, profile.publication, profile.cookie);
    try {
      const bylineUserId = await client.ownerUserId();
      const draft = await client.createDraft({
        title,
        subtitle,
        body: JSON.stringify(document),
        bylineUserId,
        audience,
      });
      // The release endpoint refuses drafts that never went through a
      // publish-settings save; this one-field update is that save.
      await client.updateDraft(draft.id, { section_chosen: true });
      try {
        await client.scheduleRelease(draft.id, when.toISOString(), audience);
        const active = await client.getScheduledRelease(draft.id);
        if (active.length === 0) {
          throw new Error(`the API accepted the release time for ${draft.id} but lists no scheduled release`);
        }
      } catch (error) {
        // A draft left behind by a failed scheduling is invisible clutter;
        // remove it so the command either schedules fully or not at all.
        try {
          await client.deleteDraft(draft.id);
        } catch {
          env.stderr.write(`warning: could not remove the leftover draft ${draft.id}\n`);
        }
        throw error;
      }
      env.stdout.write(`scheduled ${draft.id}\n`);
      env.stdout.write(`release at: ${when.toISOString()}\n`);
      if (draft.slug !== null) {
        env.stdout.write(`url: ${profile.publication}/p/${draft.slug}\n`);
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
