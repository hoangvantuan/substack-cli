import { parsePostFile, type PostFile } from '../conversion/frontmatter.js';
import { convertMarkdownToDocument } from '../conversion/markdown.js';
import { validateDocument } from '../conversion/schema.js';
import type { SubstackDocument } from '../conversion/types.js';
import type { Env } from '../env/types.js';
import { UsageError } from '../exit.js';
import type { SubstackClient } from './api.js';
import { dirnameOf, localImageSources, uploadLocalImages } from './images.js';

/**
 * Replacing an existing post's content from a Markdown file, shared by
 * `post update` (drafts and scheduled posts) and `post revise` (published
 * posts). It owns the field rule both commands follow:
 *
 * - title and body always come from the file (a --title flag overrides the
 *   file's title, as it does for `post create`);
 * - subtitle, cover, section, and slug change only when the front matter or
 *   a flag names them; a field nobody names keeps its current value;
 * - audience is never changed here, so a front matter audience is ignored
 *   with a warning.
 */

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A flag value already read from the command line, per field. */
export interface ChangeFlags {
  title?: string;
  subtitle?: string;
  cover?: string;
  section?: string;
  slug?: string;
}

/**
 * The change a command will send. Every field that is undefined keeps its
 * current value on the post. `body` is present only when a file was read.
 */
export interface PostChange {
  title?: string;
  subtitle?: string;
  cover?: string;
  /** A section name or slug, resolved to an id only when sending. */
  section?: string;
  slug?: string;
  body?: {
    document: SubstackDocument;
    /** The directory local image paths resolve against. */
    baseDir: string;
  };
}

/** Reads a post file and warns about every front matter key the tool does not know. */
export async function readPostSource(env: Env, file: string): Promise<PostFile> {
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
  return post;
}

/** Converts a Markdown body, reporting conversion warnings and refusing a document the local schema rejects. */
export function convertPostBody(env: Env, markdown: string): SubstackDocument {
  const { document, warnings } = convertMarkdownToDocument(markdown);
  for (const warning of warnings) {
    env.stderr.write(`warning: ${warning}\n`);
  }
  const violations = validateDocument(document);
  if (violations.length > 0) {
    throw new Error(`document failed local schema validation: ${violations[0]}`);
  }
  return document;
}

/**
 * Builds the change from an optional file and the flags, applying the field
 * rule. Invalid values are usage errors when they came from a flag and plain
 * errors when they came from the file, as `post create` reports them.
 */
export async function readPostChange(env: Env, file: string | undefined, flags: ChangeFlags): Promise<PostChange> {
  const fields: Record<string, string> = {};
  const change: PostChange = {};
  if (file !== undefined) {
    const post = await readPostSource(env, file);
    Object.assign(fields, post.fields);
    if ('audience' in fields) {
      env.stderr.write(
        'warning: ignoring front matter field "audience": changing the audience of an existing post is not supported\n',
      );
    }
    const title = flags.title ?? fields['title'];
    if (title === undefined || title === '') {
      throw new Error('missing title: set "title" in the front matter or pass --title');
    }
    change.body = { document: convertPostBody(env, post.body), baseDir: dirnameOf(file) };
  }
  const pick = (name: keyof ChangeFlags): string | undefined => flags[name] ?? fields[name];
  const complain = (name: keyof ChangeFlags, message: string): never => {
    throw flags[name] === undefined ? new Error(message) : new UsageError(message);
  };
  const title = pick('title');
  const subtitle = pick('subtitle');
  const cover = pick('cover');
  const section = pick('section');
  const slug = pick('slug');
  if (slug !== undefined && !SLUG.test(slug)) {
    complain('slug', `invalid slug "${slug}": use lowercase words separated by single hyphens`);
  }
  if (cover !== undefined && !/^https?:\/\//i.test(cover)) {
    complain('cover', `invalid cover "${cover}": must be an http(s) URL`);
  }
  if (title !== undefined) change.title = title;
  if (subtitle !== undefined) change.subtitle = subtitle;
  if (cover !== undefined) change.cover = cover;
  if (section !== undefined) change.section = section;
  if (slug !== undefined) change.slug = slug;
  return change;
}

/** True when the change names nothing at all. */
export function isEmptyChange(change: PostChange): boolean {
  return Object.values(change).every((value) => value === undefined);
}

/**
 * The PUT /api/v1/drafts/{id} body for the change. The section rides as
 * `draft_section_id` once resolved; before that (a dry run) it is left out
 * and the caller shows the name instead.
 */
export function draftPatch(change: PostChange, sectionId?: number): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (change.title !== undefined) patch['draft_title'] = change.title;
  if (change.subtitle !== undefined) patch['draft_subtitle'] = change.subtitle;
  if (change.body !== undefined) patch['draft_body'] = JSON.stringify(change.body.document);
  if (change.slug !== undefined) patch['slug'] = change.slug;
  if (change.cover !== undefined) patch['cover_image'] = change.cover;
  if (sectionId !== undefined) patch['draft_section_id'] = sectionId;
  return patch;
}

/** For a dry run: names the local images a real run would upload. */
export function warnLocalImages(env: Env, change: PostChange): void {
  if (change.body === undefined) {
    return;
  }
  const locals = localImageSources(change.body.document);
  if (locals.length > 0) {
    env.stderr.write(
      `warning: ${locals.length} local image${locals.length === 1 ? '' : 's'} ` +
        `(${locals.join(', ')}) will be uploaded when the post is sent\n`,
    );
  }
}

/**
 * Makes the change sendable: resolves the section name to its id and
 * uploads local body images, rewriting their src in place. The section is
 * resolved first so an unknown name costs no upload. Returns the section id
 * when the change names a section.
 */
export async function prepareChange(env: Env, client: SubstackClient, change: PostChange): Promise<number | undefined> {
  let sectionId: number | undefined;
  if (change.section !== undefined) {
    const sections = await client.listSections();
    const match = sections.find((entry) => entry.name === change.section || entry.slug === change.section);
    if (match === undefined) {
      const available = sections.length === 0
        ? 'the publication has no sections'
        : `available sections: ${sections.map((entry) => entry.name).join(', ')}`;
      throw new UsageError(`unknown section "${change.section}" (${available})`);
    }
    sectionId = match.id;
  }
  if (change.body !== undefined) {
    await uploadLocalImages(env, client, change.body.document, change.body.baseDir);
  }
  return sectionId;
}
