/**
 * Minimal front matter parser, written for this tool: a pair of `---` lines
 * around flat `key: value` string pairs. No YAML, no nesting, no quoting
 * beyond an optional pair of matching quotes around the whole value.
 *
 * The post keys are the shared front matter contract: title, subtitle,
 * section, cover, audience, slug. Any other key (including the keys the
 * crawl command writes) is reported as unknown so the command can warn and
 * ignore it.
 */

export const POST_FRONT_MATTER_KEYS = ['title', 'subtitle', 'section', 'cover', 'audience', 'slug'] as const;

export interface PostFile {
  fields: Record<string, string>;
  unknownFields: string[];
  body: string;
}

const FIELD = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/;
const FENCE_LINE = /^---[ \t]*$/;

/**
 * Splits a post file into front matter fields and the Markdown body. A file
 * whose first line is not `---`, or whose front matter is never closed, is
 * treated as all body (a lone `---` is a thematic break, not front matter).
 */
export function parsePostFile(contents: string): PostFile {
  const lines = contents.replace(/\r\n?/g, '\n').split('\n');
  if (!FENCE_LINE.test(lines[0] ?? '')) {
    return { fields: {}, unknownFields: [], body: contents };
  }
  const closing = lines.findIndex((line, index) => index > 0 && FENCE_LINE.test(line));
  if (closing === -1) {
    return { fields: {}, unknownFields: [], body: contents };
  }
  const fields: Record<string, string> = {};
  const unknownFields: string[] = [];
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '') {
      continue;
    }
    const match = line.match(FIELD);
    if (match === null) {
      throw new Error(`invalid front matter line ${index + 1}: "${line}"`);
    }
    const key = match[1]!;
    const value = unquote(match[2]!.trim());
    if (key in fields) {
      throw new Error(`duplicate front matter key: ${key}`);
    }
    if ((POST_FRONT_MATTER_KEYS as readonly string[]).includes(key)) {
      fields[key] = value;
    } else {
      unknownFields.push(key);
    }
  }
  return { fields, unknownFields, body: lines.slice(closing + 1).join('\n') };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]!;
    const last = value[value.length - 1]!;
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
