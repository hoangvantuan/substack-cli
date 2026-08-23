import { parseArgv } from '../args.js';
import { parsePostFile } from '../conversion/frontmatter.js';
import { convertMarkdownToDocument } from '../conversion/markdown.js';
import { validateDocument } from '../conversion/schema.js';
import type { Subcommand } from '../commands.js';
import type { Env } from '../env/types.js';
import { EXIT_FAILURE, EXIT_SUCCESS, UsageError } from '../exit.js';

export const createUsage =
  'usage: substackctl post create <file> [--dry-run] [--title <t>] [--subtitle <s>]\n' +
  '                                  [--section <name>] [--cover <url>] [--audience <a>] [--slug <slug>]';

const AUDIENCES: Record<string, true> = { everyone: true, only_paid: true, only_free: true, founding: true };
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const createCommand: Subcommand = {
  name: 'create',
  description: 'convert a Markdown file into a Substack document and preview the draft request',
  usage: createUsage,
  async run(argv, env) {
    const parsed = parseArgv(argv, {
      strings: ['title', 'subtitle', 'section', 'cover', 'audience', 'slug'],
      booleans: ['dry-run'],
    });
    const file = parsed.positionals[0];
    if (file === undefined) {
      throw new UsageError('missing <file>');
    }
    if (parsed.positionals.length > 1) {
      throw new UsageError(`unexpected argument: ${parsed.positionals[1]}`);
    }
    if (parsed.values.get('dry-run') !== true) {
      env.stderr.write('sending is not implemented yet; run with --dry-run to preview the request\n');
      return EXIT_FAILURE;
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
      throw new Error(`invalid audience "${audience}": expected everyone, only_paid, only_free, or founding`);
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
    const body: Record<string, unknown> = {
      draft_title: title,
      draft_subtitle: subtitle,
      draft_body: JSON.stringify(document),
      draft_bylines: [{ id: null, is_guest: false }],
      type: 'newsletter',
      audience,
    };
    if (cover !== undefined) {
      body['cover_image'] = cover;
    }
    const request: Record<string, unknown> = { method: 'POST', url: '/api/v1/drafts', body };
    if (slug !== undefined || section !== undefined) {
      const afterCreate: Record<string, string> = {};
      if (slug !== undefined) {
        afterCreate['slug'] = slug;
      }
      if (section !== undefined) {
        afterCreate['section'] = section;
      }
      request['after_create'] = afterCreate;
    }
    env.stdout.write(JSON.stringify(request, null, 2) + '\n');
    return EXIT_SUCCESS;
  },
};
