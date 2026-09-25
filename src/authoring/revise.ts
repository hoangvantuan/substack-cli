import { parseArgv } from '../args.js';
import type { Subcommand } from '../commands.js';
import type { Env } from '../env/types.js';
import { EXIT_AUTH, EXIT_FAILURE, EXIT_SUCCESS, UsageError } from '../exit.js';
import { configDir, loadConfig } from '../profiles/config.js';
import { hasEnvironmentProfile, resolveProfile, warnIfCookieStale } from '../profiles/resolve.js';
import { htmlToMarkdown } from '../reading/crawl-markdown.js';
import { AuthError, SubstackClient, type RevisionRecord } from './api.js';
import { draftPatch, isEmptyChange, prepareChange, readPostChange, warnLocalImages, type PostChange } from './content.js';

export const reviseUsage =
  'usage: sub-cli post revise <id> [file] --profile <name> --yes [--title <t>] [--subtitle <s>] [--section <name>]\n' +
  '                               [--cover <url>] [--slug <slug> --change-url] [--dry-run]';

const PUBLISH_BODY = { send: false, share_automatically: false };

const SLUG_WARNING =
  'there is no redirect: the old URL keeps serving a frozen copy of the post that later revisions never reach';

export const reviseCommand: Subcommand = {
  name: 'revise',
  description: "change a published post's content (from a file) or metadata in place; goes live without re-sending the email",
  usage: reviseUsage,
  async run(argv, env) {
    const parsed = parseArgv(argv, {
      strings: ['title', 'subtitle', 'section', 'cover', 'slug', 'profile'],
      booleans: ['yes', 'dry-run', 'change-url'],
    });
    const idRaw = parsed.positionals[0];
    if (idRaw === undefined) {
      throw new UsageError('missing <id>');
    }
    if (parsed.positionals.length > 2) {
      throw new UsageError(`unexpected argument: ${parsed.positionals[2]}`);
    }
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id < 1) {
      throw new UsageError(`<id> must be a positive integer: ${idRaw}`);
    }
    const flag = (name: string): string | undefined => {
      const value = parsed.values.get(name);
      return typeof value === 'string' ? value : undefined;
    };
    const dryRun = parsed.values.get('dry-run') === true;
    // ADR 0004 and 0006: a revision is public the moment it lands, so it is
    // guarded like publishing. A dry run lands nothing and needs no --yes,
    // but it still names the publication explicitly so the preview is of
    // the post the real run would change.
    const missing: string[] = [];
    if (flag('profile') === undefined && !hasEnvironmentProfile(env)) {
      missing.push('--profile <name>');
    }
    if (!dryRun && parsed.values.get('yes') !== true) {
      missing.push('--yes');
    }
    if (missing.length > 0) {
      throw new UsageError(
        `refusing to revise: a revision goes live at once, pass ${missing.join(' and ')} to confirm`,
      );
    }
    const change = await readPostChange(env, parsed.positionals[1], {
      title: flag('title'),
      subtitle: flag('subtitle'),
      cover: flag('cover'),
      section: flag('section'),
      slug: flag('slug'),
    });
    if (isEmptyChange(change)) {
      throw new UsageError('nothing to revise: pass a file, --title, --subtitle, --section, --cover, or --slug');
    }
    const config = await loadConfig(env);
    const profile = resolveProfile(env, config, flag('profile'));
    warnIfCookieStale(env, profile);
    env.stderr.write(
      `sub-cli: ${dryRun ? 'previewing a revision of' : 'revising'} post ${id} on profile ${profile.name ?? 'environment'} (${profile.publication})\n`,
    );
    const client = new SubstackClient(env, profile.publication, profile.cookie);
    try {
      const record = await client.revisionRecord(id);
      if (!record.published) {
        env.stderr.write(
          `sub-cli: post ${id} is ${record.scheduled ? 'scheduled' : 'a draft'}; post revise changes published posts only. ` +
            `To change it, use: sub-cli post update ${id}\n`,
        );
        return EXIT_FAILURE;
      }
      if (change.slug !== undefined && change.slug === record.slug) {
        delete change.slug;
        if (isEmptyChange(change)) {
          env.stderr.write(`sub-cli: nothing to revise: post ${id} already has the slug ${record.slug}\n`);
          return EXIT_FAILURE;
        }
      }
      // Each refusal is a message; a dry run prints its preview first, so a
      // URL change or pending changes can be previewed without approving them.
      const refusals: string[] = [];
      if (change.slug !== undefined) {
        if (parsed.values.get('change-url') === true) {
          env.stderr.write(`warning: changing the URL of post ${id} to ${change.slug}: ${SLUG_WARNING}\n`);
        } else {
          refusals.push(
            `refusing to change the URL of post ${id} from ${record.slug ?? '(none)'} to ${change.slug}: ` +
              `${SLUG_WARNING}. Pass --change-url to change it anyway`,
          );
        }
      }
      const pending = pendingChanges(record, change);
      if (pending.length > 0) {
        refusals.push(
          `post ${id} has pending changes (${pending.join(', ')}) saved in the web editor but not live; ` +
            `a revision would publish them too. Resolve them in Substack's editor first, ` +
            `or overwrite them by naming those fields in this revision`,
        );
      }
      const backup = backupPath(env, profile.publication, id);
      if (dryRun) {
        warnLocalImages(env, change);
        const put: Record<string, unknown> = { method: 'PUT', url: `/api/v1/drafts/${id}`, body: draftPatch(change) };
        if (change.section !== undefined) {
          put['section'] = change.section;
        }
        const preview = {
          requests: [put, { method: 'POST', url: `/api/v1/drafts/${id}/publish`, body: PUBLISH_BODY }],
          backup,
          pending_changes: pending,
        };
        env.stdout.write(JSON.stringify(preview, null, 2) + '\n');
      }
      if (refusals.length > 0) {
        for (const refusal of refusals) {
          env.stderr.write(`sub-cli: ${refusal}\n`);
        }
        return EXIT_FAILURE;
      }
      if (dryRun) {
        return EXIT_SUCCESS;
      }
      // An unknown section fails here, before the backup and before any write.
      const sectionId = await prepareChange(env, client, change);
      await writeBackup(env, client, profile.publication, record, backup);
      env.stdout.write(`backup: ${backup}\n`);
      // The PUT stages title, subtitle, body, and section while slug and
      // cover go live at once; the republish with send:false then copies the
      // staged fields live without emailing anyone or moving the post date.
      const patch = draftPatch(change, sectionId);
      await client.updateDraft(id, patch);
      await client.publishDraft(id, { sendEmail: false });
      const after = await client.revisionRecord(id);
      const stale = notLive(after, patch);
      if (stale.length > 0) {
        env.stderr.write(
          `sub-cli: post ${id} was republished but these fields did not go live: ${stale.join(', ')}; ` +
            `the backup is at ${backup}\n`,
        );
        return EXIT_FAILURE;
      }
      env.stdout.write(`revised ${id}\n`);
      const slug = after.slug ?? change.slug ?? record.slug;
      if (slug !== null) {
        env.stdout.write(`url: ${profile.publication}/p/${slug}\n`);
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

/**
 * The staged fields that differ from the live ones and that this revision
 * would not overwrite. A republish pushes every staged field, so each one
 * listed here would go live without the caller asking for it.
 */
function pendingChanges(record: RevisionRecord, change: PostChange): string[] {
  const pending: string[] = [];
  if (change.title === undefined && (record.title ?? '') !== (record.draft_title ?? '')) {
    pending.push('title');
  }
  if (change.subtitle === undefined && (record.subtitle ?? '') !== (record.draft_subtitle ?? '')) {
    pending.push('subtitle');
  }
  if (change.body === undefined && (record.body ?? '') !== (record.draft_body ?? '')) {
    pending.push('body');
  }
  if (change.section === undefined && record.section_id !== record.draft_section_id) {
    pending.push('section');
  }
  return pending;
}

/**
 * The fields of the sent patch that the post does not show live afterwards.
 * The API stores `draft_body` verbatim (checked on the test publication), so
 * the live body is compared with the exact string sent.
 */
function notLive(after: RevisionRecord, patch: Record<string, unknown>): string[] {
  const live: Record<string, [string, unknown]> = {
    draft_title: ['title', after.title],
    draft_subtitle: ['subtitle', after.subtitle ?? ''],
    draft_body: ['body', after.body],
    draft_section_id: ['section', after.section_id],
    slug: ['slug', after.slug],
    cover_image: ['cover', after.cover_image],
  };
  return Object.entries(patch)
    .filter(([key, sent]) => live[key] !== undefined && live[key][1] !== sent)
    .map(([key]) => live[key]![0]);
}

/** `<config>/backups/<publication host>/<id>-<UTC timestamp>.md`. */
function backupPath(env: Env, publication: string, id: number): string {
  const stamp = new Date(env.clock()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${configDir(env)}/backups/${new URL(publication).hostname}/${id}-${stamp}.md`;
}

/**
 * Saves the live post as a Markdown file, converted the way `feed crawl`
 * converts. The front matter holds only post keys, so the backup is itself
 * a valid revise file: `sub-cli post revise <id> <backup>` restores it.
 */
async function writeBackup(
  env: Env,
  client: SubstackClient,
  publication: string,
  record: RevisionRecord,
  path: string,
): Promise<void> {
  if (record.slug === null) {
    throw new Error('cannot back up the live post: it has no slug');
  }
  const live = await client.publicPost(record.slug);
  const text = (key: string): string => (typeof live[key] === 'string' ? (live[key] as string) : '');
  const front = ['---', `title: ${quoted(text('title'))}`, `subtitle: ${quoted(text('subtitle'))}`, `slug: ${quoted(record.slug)}`];
  if (text('cover_image') !== '') {
    front.push(`cover: ${quoted(text('cover_image'))}`);
  }
  front.push('---');
  const markdown = htmlToMarkdown(text('body_html'), { baseUrl: publication });
  const contents = `${front.join('\n')}\n${markdown === '' ? '' : `\n${markdown}\n`}`;
  await env.fs.mkdir(path.slice(0, path.lastIndexOf('/')));
  await env.fs.writeFile(path, contents);
}

/** The front matter parser strips one pair of outer quotes and nothing else. */
function quoted(value: string): string {
  return `"${value.replace(/\s*\n\s*/g, ' ')}"`;
}
