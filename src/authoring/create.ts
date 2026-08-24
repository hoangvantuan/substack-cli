import { parseArgv } from '../args.js';
import { parsePostFile } from '../conversion/frontmatter.js';
import { convertMarkdownToDocument } from '../conversion/markdown.js';
import { validateDocument } from '../conversion/schema.js';
import type { Subcommand } from '../commands.js';
import type { Env } from '../env/types.js';
import { EXIT_AUTH, EXIT_SUCCESS, UsageError } from '../exit.js';
import { loadConfig } from '../profiles/config.js';
import { resolveProfile, warnIfCookieStale } from '../profiles/resolve.js';
import { dirnameOf, localImageSources, uploadLocalImages } from './images.js';
import { AuthError, SubstackClient } from './api.js';

export const createUsage =
  'usage: sub-cli post create <file> [--profile <name>] [--dry-run] [--title <t>]\n' +
  '                                  [--subtitle <s>] [--section <name>] [--cover <url>]\n' +
  '                                  [--audience <a>] [--slug <slug>]';

const AUDIENCES: Record<string, true> = { everyone: true, only_paid: true, only_free: true, founding: true };
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const createCommand: Subcommand = {
  name: 'create',
  description: 'convert a Markdown file into a Substack document and send it as a new draft',
  usage: createUsage,
  async run(argv, env) {
    const parsed = parseArgv(argv, {
      strings: ['title', 'subtitle', 'section', 'cover', 'audience', 'slug', 'profile'],
      booleans: ['dry-run'],
    });
    const file = parsed.positionals[0];
    if (file === undefined) {
      throw new UsageError('missing <file>');
    }
    if (parsed.positionals.length > 1) {
      throw new UsageError(`unexpected argument: ${parsed.positionals[1]}`);
    }
    const dryRun = parsed.values.get('dry-run') === true;
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
    const flag = (name: string): string | undefined => {
      const value = parsed.values.get(name);
      return typeof value === 'string' ? value : undefined;
    };
    const title = flag('title') ?? post.fields['title'];
    if (title === undefined || title === '') {
      throw new Error('missing title: set "title" in the front matter or pass --title');
    }
    const subtitle = flag('subtitle') ?? post.fields['subtitle'] ?? '';
    const section = flag('section') ?? post.fields['section'];
    const cover = flag('cover') ?? post.fields['cover'];
    const audience = flag('audience') ?? post.fields['audience'] ?? 'everyone';
    if (!(audience in AUDIENCES)) {
      const complaint = `invalid audience "${audience}": expected everyone, only_paid, only_free, or founding`;
      // A flag is a command-line mistake (exit 2); the same value in the file
      // is a bad input file (exit 1).
      throw flag('audience') === undefined ? new Error(complaint) : new UsageError(complaint);
    }
    const slug = flag('slug') ?? post.fields['slug'];
    if (slug !== undefined && !SLUG.test(slug)) {
      throw new Error(`invalid slug "${slug}": use lowercase words separated by single hyphens`);
    }
    if (cover !== undefined && !/^https?:\/\//i.test(cover)) {
      throw new Error(`invalid cover "${cover}": must be an http(s) URL`);
    }
    const { document, warnings } = convertMarkdownToDocument(post.body);
    for (const warning of warnings) {
      env.stderr.write(`warning: ${warning}\n`);
    }
    const violations = validateDocument(document);
    if (violations.length > 0) {
      throw new Error(`document failed local schema validation: ${violations[0]}`);
    }
    if (dryRun) {
      const locals = localImageSources(document);
      if (locals.length > 0) {
        env.stderr.write(
          `warning: ${locals.length} local image${locals.length === 1 ? '' : 's'} ` +
            `(${locals.join(', ')}) will be uploaded when the post is sent\n`,
        );
      }
      printDryRun(env, { title, subtitle, document, audience, cover, slug, section });
      return EXIT_SUCCESS;
    }
    const config = await loadConfig(env);
    const profile = resolveProfile(env, config, flag('profile'));
    warnIfCookieStale(env, profile);
    env.stderr.write(`sub-cli: creating a draft on profile ${profile.name ?? 'environment'} (${profile.publication})\n`);
    const client = new SubstackClient(env, profile.publication, profile.cookie);
    try {
      const bylineUserId = await client.ownerUserId();
      // The section is resolved before the draft exists: an unknown name used
      // to create the draft first and fail afterwards, leaving it behind.
      const sectionId = section === undefined ? undefined : await sectionIdFor(client, section);
      // Local body images are uploaded and rewritten to hosted URLs before
      // the draft is created, so a missing file stops the command instead of
      // producing a post with a broken image.
      await uploadLocalImages(env, client, document, dirnameOf(file));
      const draft = await client.createDraft({
        title,
        subtitle,
        body: JSON.stringify(document),
        bylineUserId,
        audience,
        ...(cover === undefined ? {} : { coverImage: cover }),
      });
      let created;
      try {
        if (slug !== undefined || sectionId !== undefined) {
          const patch: Record<string, unknown> = {};
          if (slug !== undefined) {
            patch['slug'] = slug;
          }
          if (sectionId !== undefined) {
            patch['draft_section_id'] = sectionId;
          }
          await client.updateDraft(draft.id, patch);
          if (sectionId !== undefined) {
            await verifySectionAssignment(client, draft.id, sectionId, section!);
          }
        }
        created = await client.getDraft(draft.id);
      } catch (error) {
        // A half-made draft is invisible clutter -- a rejected slug used to
        // leave one behind. The command either creates the post as asked or
        // leaves nothing, the same rule `post schedule` follows.
        try {
          await client.deleteDraft(draft.id);
        } catch {
          env.stderr.write(`warning: could not remove the leftover draft ${draft.id}\n`);
        }
        throw error;
      }
      env.stdout.write(`draft ${created.id}\n`);
      if (created.slug !== null) {
        env.stdout.write(`url: ${profile.publication}/p/${created.slug}\n`);
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

/** Resolves a section by name; the API knows sections by id, not name. */
async function sectionIdFor(client: SubstackClient, section: string): Promise<number> {
  const sections = await client.listSections();
  const match = sections.find((candidate) => candidate.name === section);
  if (match === undefined) {
    const known = sections.map((candidate) => `"${candidate.name}"`).join(', ');
    throw new Error(
      `unknown section "${section}"${known === '' ? ' (the publication has no sections)' : `; known sections: ${known}`}`,
    );
  }
  return match.id;
}

/**
 * Re-reads the draft and checks `draft_section_id`, the field the API
 * actually populates, against the intended section id. The `section_id`
 * field on the same response always reads null and would make every
 * assignment look failed.
 */
async function verifySectionAssignment(
  client: SubstackClient,
  draftId: number,
  sectionId: number,
  section: string,
): Promise<void> {
  const verified = await client.getDraft(draftId);
  if (verified.draft_section_id !== sectionId) {
    throw new Error(
      `the section assignment could not be verified: draft_section_id is ` +
        `${verified.draft_section_id === null ? 'empty' : verified.draft_section_id}, ` +
        `expected ${sectionId} for "${section}"`,
    );
  }
}

/**
 * The dry-run preview: the request as it would be sent, with the byline id
 * shown as null because it is looked up from the API only when sending.
 */
function printDryRun(
  env: Env,
  post: {
    title: string;
    subtitle: string;
    document: unknown;
    audience: string;
    cover?: string;
    slug?: string;
    section?: string;
  },
): void {
  const body: Record<string, unknown> = {
    draft_title: post.title,
    draft_subtitle: post.subtitle,
    draft_body: JSON.stringify(post.document),
    draft_bylines: [{ id: null, is_guest: false }],
    type: 'newsletter',
    audience: post.audience,
  };
  if (post.cover !== undefined) {
    body['cover_image'] = post.cover;
  }
  const request: Record<string, unknown> = { method: 'POST', url: '/api/v1/drafts', body };
  if (post.slug !== undefined || post.section !== undefined) {
    const afterCreate: Record<string, string> = {};
    if (post.slug !== undefined) {
      afterCreate['slug'] = post.slug;
    }
    if (post.section !== undefined) {
      afterCreate['section'] = post.section;
    }
    request['after_create'] = afterCreate;
  }
  env.stdout.write(JSON.stringify(request, null, 2) + '\n');
}
