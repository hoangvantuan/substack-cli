import type { PMMark, PMNode, SubstackDocument } from './types.js';

/** Thrown when the Markdown contains a construct outside the supported set. */
export class ConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversionError';
  }
}

interface Line {
  text: string;
  number: number;
}

interface Warnings {
  messages: string[];
}

interface ImageInline {
  kind: 'image';
  src: string;
  alt: string;
  title: string | null;
  href: string | null;
  line: number;
}

type Inline = PMNode | ImageInline;

/**
 * Converts a Markdown body (front matter already stripped) into a Substack
 * ProseMirror document. Pure: no I/O, no clock, no configuration.
 *
 * A construct outside the supported set => ConversionError naming the
 * construct; nothing is ever silently dropped or downgraded.
 */
export function convertMarkdownToDocument(markdown: string): { document: SubstackDocument; warnings: string[] } {
  const context: Warnings = { messages: [] };
  const lines = splitLines(markdown);
  const content = parseBlocks(lines, context);
  if (content.length === 0) {
    throw new ConversionError('the post body is empty: add content below the front matter');
  }
  return { document: { type: 'doc', content }, warnings: context.messages };
}

function splitLines(markdown: string): Line[] {
  return markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((text, index) => ({ text, number: index + 1 }));
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+[ \t]*)?$/;
const THEMATIC = /^ {0,3}([-_*])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const QUOTE_MARKER = /^ {0,3}>/;
const QUOTE_STRIP = /^ {0,3}> ?/;
const BULLET_ITEM = /^ {0,3}([-+*])[ \t]+.*$|^ {0,3}([-+*])[ \t]*$/;
const ORDERED_ITEM = /^ {0,3}([0-9]{1,9})([.)])[ \t]+.*$|^ {0,3}([0-9]{1,9})([.)])[ \t]*$/;
const HTML_BLOCK = /^ {0,3}<(?:[a-zA-Z!/?])/;
const FOOTNOTE_DEF = /^ {0,3}\[\^[^\]]+\]:/;
const REFERENCE_DEF = /^ {0,3}\[[^\]^][^\]]*\]:[ \t]*\S/;
const TABLE_DELIM = /^[ |:-]+$/;
const PUNCTUATION = /^[-!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~]$/;

function isBlank(line: Line): boolean {
  return line.text.trim() === '';
}

function isTableDelimiter(text: string): boolean {
  return text.includes('|') && text.includes('-') && TABLE_DELIM.test(text);
}
function interruptsParagraph(line: Line): boolean {
  const text = line.text;
  if (FENCE.test(text) || ATX.test(text) || QUOTE_MARKER.test(text) || THEMATIC.test(text)) {
    return true;
  }
  if (BULLET_ITEM.test(text)) {
    return true;
  }
  const ordered = text.match(ORDERED_ITEM);
  if (ordered !== null) {
    const number = ordered[1] ?? ordered[3];
    return number === '1';
  }
  return false;
}

function parseBlocks(lines: Line[], context: Warnings): PMNode[] {
  const blocks: PMNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (/^( {4,}|\t)/.test(line.text)) {
      throw new ConversionError(
        `indented code block is not supported (line ${line.number}): wrap the code in a fenced block (\`\`\`)`,
      );
    }
    if (FENCE.test(line.text)) {
      const [consumed, node] = parseFence(lines, i);
      blocks.push(node);
      i = consumed;
      continue;
    }
    const atx = line.text.match(ATX);
    if (atx !== null) {
      const hashes = atx[1]!.length;
      if (hashes === 6) {
        throw new ConversionError(
          `a sixth-level heading (######) has no room to shift down one level and is rejected (line ${line.number})`,
        );
      }
      const inline = parseInlineRun(atx[2] ?? '', [], line.number);
      if (inline.some(isImage)) {
        throw new ConversionError(`an image inside a heading is not supported (line ${line.number})`);
      }
      blocks.push({
        type: 'heading',
        attrs: { level: hashes + 1 },
        content: coalesce(inline),
      });
      i += 1;
      continue;
    }
    if (THEMATIC.test(line.text)) {
      blocks.push({ type: 'horizontal_rule' });
      i += 1;
      continue;
    }
    if (QUOTE_MARKER.test(line.text)) {
      const [consumed, node] = parseBlockquote(lines, i, context);
      blocks.push(node);
      i = consumed;
      continue;
    }
    if (HTML_BLOCK.test(line.text)) {
      throw new ConversionError(`raw html is not supported (line ${line.number})`);
    }
    if (FOOTNOTE_DEF.test(line.text)) {
      throw new ConversionError(`footnote is not supported (line ${line.number})`);
    }
    if (REFERENCE_DEF.test(line.text)) {
      throw new ConversionError(
        `reference link definition is not supported (line ${line.number}): use inline links [text](url)`,
      );
    }
    if (BULLET_ITEM.test(line.text) || ORDERED_ITEM.test(line.text)) {
      const [consumed, node] = parseList(lines, i, context);
      blocks.push(node);
      i = consumed;
      continue;
    }
    const [consumed, node] = parseParagraph(lines, i, context);
    blocks.push(node);
    i = consumed;
  }
  return blocks;
}

/** Returns [index after the closing fence, node]. An unclosed fence runs to the end of the body. */
function parseFence(lines: Line[], start: number): [number, PMNode] {
  const opening = lines[start]!.text.match(FENCE)!;
  const marker = opening[1]!;
  const info = (opening[2] ?? '').trim();
  const language = info === '' ? 'plaintext' : info.split(/\s+/)[0]!.toLowerCase();
  const body: string[] = [];
  let i = start + 1;
  while (i < lines.length) {
    const text = lines[i]!.text;
    const closing = text.match(FENCE_CLOSE);
    if (closing !== null && closing[1]![0] === marker[0] && closing[1]!.length >= marker.length) {
      i += 1;
      break;
    }
    body.push(text);
    i += 1;
  }
  const code = body.join('\n').replace(/\n$/, '');
  const content: PMNode[] = code === '' ? [] : [{ type: 'text', text: code }];
  return [i, { type: 'highlighted_code_block', attrs: { language, nodeId: null }, content }];
}

/** Returns [index after the blockquote, node]. */
function parseBlockquote(lines: Line[], start: number, context: Warnings): [number, PMNode] {
  const inner: Line[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (QUOTE_MARKER.test(line.text)) {
      inner.push({ text: line.text.replace(QUOTE_STRIP, ''), number: line.number });
      i += 1;
      continue;
    }
    if (isBlank(line)) {
      const next = lines[i + 1];
      if (next !== undefined && QUOTE_MARKER.test(next.text)) {
        inner.push({ text: '', number: line.number });
        i += 1;
        continue;
      }
      break;
    }
    const last = inner[inner.length - 1];
    if (last !== undefined && !isBlank(last) && !interruptsParagraph(line)) {
      // Lazy continuation: a paragraph line inside the quote without the marker.
      inner.push({ text: line.text.replace(/^ {0,3}/, ''), number: line.number });
      i += 1;
      continue;
    }
    break;
  }
  const content = parseBlocks(inner, context);
  return [i, { type: 'blockquote', content: content.length > 0 ? content : [{ type: 'paragraph', content: [] }] }];
}

/** Returns [index after the list, node]. */
function parseList(lines: Line[], start: number, context: Warnings): [number, PMNode] {
  const first = lines[start]!.text;
  const isOrdered = ORDERED_ITEM.test(first);
  const firstMatch = first.match(isOrdered ? ORDERED_ITEM : BULLET_ITEM)!;
  const firstNumber = isOrdered ? Number(firstMatch[1] ?? firstMatch[3]) : 1;
  const bulletChar = !isOrdered ? (firstMatch[1] ?? firstMatch[2]) : null;
  const orderedDelim = isOrdered ? (firstMatch[2] ?? firstMatch[4]) : null;
  const items: PMNode[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      const next = lines[i + 1];
      if (
        next !== undefined &&
        (BULLET_ITEM.test(next.text) || ORDERED_ITEM.test(next.text) || /^( {2,}|\t)/.test(next.text))
      ) {
        i += 1;
        continue;
      }
      break;
    }
    const match = line.text.match(isOrdered ? ORDERED_ITEM : BULLET_ITEM);
    const indentWidth = line.text.match(/^ */)![0].length;
    const stillSameList =
      match !== null &&
      indentWidth <= 3 &&
      (isOrdered ? (match[2] ?? match[4]) === orderedDelim : (match[1] ?? match[2]) === bulletChar);
    if (!stillSameList) {
      break;
    }
    const [next, item] = parseListItem(lines, i, context);
    items.push(item);
    i = next;
  }
  const node: PMNode = isOrdered
    ? {
        type: 'ordered_list',
        ...(firstNumber !== 1 ? { attrs: { order: firstNumber } } : {}),
        content: items,
      }
    : { type: 'bullet_list', content: items };
  return [i, node];
}

/** Returns [index after the item, node]. */
function parseListItem(lines: Line[], start: number, context: Warnings): [number, PMNode] {
  const text = lines[start]!.text;
  const markerMatch = text.match(/^ *(?:([-+*])(?:[ \t]+(.*))?$|([0-9]{1,9})([.)])(?:[ \t]+(.*))?$)/)!;
  const markerWidth = markerMatch[0].replace(/[ \t]+.*$/, '').length;
  const firstContent = markerMatch[2] ?? markerMatch[5] ?? '';
  const contentIndent = markerWidth + text.slice(markerWidth).match(/^[ \t]*/)![0].length;
  const itemLines: Line[] = [];
  if (firstContent !== '') {
    itemLines.push({ text: `${' '.repeat(contentIndent)}${firstContent}`, number: lines[start]!.number });
  }
  let i = start + 1;
  let pendingBlank: Line | undefined;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      pendingBlank = line;
      i += 1;
      continue;
    }
    const indentWidth = line.text.match(/^ */)![0].length;
    if (indentWidth >= contentIndent || (line.text.startsWith('\t') && contentIndent > 0)) {
      if (pendingBlank !== undefined) {
        itemLines.push({ text: '', number: pendingBlank.number });
        pendingBlank = undefined;
      }
      itemLines.push({ text: dedentLine(line.text, contentIndent), number: line.number });
      i += 1;
      continue;
    }
    const startsNewBlock =
      interruptsParagraph(line) ||
      HTML_BLOCK.test(line.text) ||
      BULLET_ITEM.test(line.text) ||
      ORDERED_ITEM.test(line.text);
    const lastContent = [...itemLines].reverse().find((candidate) => !isBlank(candidate));
    if (pendingBlank === undefined && lastContent !== undefined && !startsNewBlock) {
      itemLines.push({ text: line.text.replace(/^ {0,3}/, ''), number: line.number });
      i += 1;
      continue;
    }
    break;
  }
  while (itemLines.length > 0 && isBlank(itemLines[itemLines.length - 1]!)) {
    itemLines.pop();
  }
  const content = parseBlocks(itemLines, context);
  return [i, { type: 'list_item', content: content.length > 0 ? content : [{ type: 'paragraph', content: [] }] }];
}

function dedentLine(text: string, indent: number): string {
  return text.startsWith('\t') ? text.slice(1) : text.slice(indent);
}

/** Returns [index after the paragraph, node]. */
function parseParagraph(lines: Line[], start: number, context: Warnings): [number, PMNode] {
  const collected: Line[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line) || interruptsParagraph(line)) {
      break;
    }
    if (collected.length > 0 && SETEXT.test(line.text)) {
      throw new ConversionError(
        `setext heading is not supported (line ${line.number}): write the heading as "# text" instead`,
      );
    }
    if (collected.length > 0 && isTableDelimiter(line.text) && collected[collected.length - 1]!.text.includes('|')) {
      throw new ConversionError(`table is not supported (line ${line.number})`);
    }
    collected.push(line);
    i += 1;
  }
  if (collected.length === 0) {
    throw new ConversionError(`expected a paragraph (line ${start + 1})`);
  }
  return [i, paragraphNode(collected, context)];
}

function paragraphNode(lines: Line[], context: Warnings): PMNode {
  const inline: Inline[] = [];
  lines.forEach((line, index) => {
    let text = line.text.replace(/^ {0,3}/, '').replace(/\s+$/, '');
    let hardBreak = false;
    if ((/ {2,}$/.test(line.text) || /\\$/.test(line.text)) && index < lines.length - 1) {
      hardBreak = true;
      if (/\\$/.test(line.text)) {
        text = text.slice(0, -1);
      }
    }
    inline.push(...parseInlineRun(text, [], line.number));
    if (hardBreak) {
      inline.push({ type: 'hard_break' });
    } else if (index < lines.length - 1) {
      inline.push(...parseInlineRun(' ', [], line.number));
    }
  });
  const images = inline.filter(isImage);
  if (images.length === 1 && inline.length === 1) {
    return captionedImage(images[0]!, context);
  }
  if (images.length > 0) {
    throw new ConversionError(
      `an image inside a paragraph with other content is not supported (line ${images[0]!.line}): give the image a paragraph of its own`,
    );
  }
  return { type: 'paragraph', content: coalesce(inline) };
}

function captionedImage(image: ImageInline, context: Warnings): PMNode {
  if (!/^https?:\/\//i.test(image.src)) {
    throw new ConversionError(`local image is not supported (line ${image.line}): image src must be an http(s) URL`);
  }
  if (image.alt === '') {
    context.messages.push(`image without alt text (line ${image.line})`);
  }
  const content: PMNode[] = [
    {
      type: 'image2',
      attrs: {
        src: image.src,
        srcNoWatermark: null,
        fullscreen: null,
        imageSize: 'normal',
        height: null,
        width: null,
        resizeWidth: null,
        bytes: null,
        alt: image.alt === '' ? null : image.alt,
        title: null,
        type: null,
        href: image.href,
        belowTheFold: false,
        topImage: false,
        internalRedirect: null,
        isProcessing: false,
        align: null,
        offset: false,
      },
    },
  ];
  if (image.title !== null) {
    content.push({ type: 'caption', content: [{ type: 'text', text: image.title }] });
  }
  return { type: 'captionedImage', content };
}

function isImage(piece: Inline): piece is ImageInline {
  return (piece as ImageInline).kind === 'image';
}

function isWhitespace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

function isPunctuation(char: string | undefined): boolean {
  return char !== undefined && PUNCTUATION.test(char);
}

interface DelimPart {
  kind: 'delim';
  char: '*' | '_';
  count: number;
  canOpen: boolean;
  canClose: boolean;
}

interface InlinePart {
  kind: 'inline';
  inline: Inline;
}

type Part = DelimPart | InlinePart;

/**
 * Parses one line's inline content into nodes (and image markers, resolved by
 * the caller). Code spans, links, images, autolinks, and strikethrough are
 * resolved during the scan; emphasis runs are collected as delimiter parts
 * and paired afterwards with a CommonMark-style delimiter stack.
 */
function parseInlineRun(text: string, marks: PMMark[], line: number): Inline[] {
  const parts: Part[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer !== '') {
      parts.push({ kind: 'inline', inline: { type: 'text', text: buffer } });
      buffer = '';
    }
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === '\\' && PUNCTUATION.test(text[i + 1] ?? '')) {
      buffer += text[i + 1]!;
      i += 2;
      continue;
    }
    if (char === '`') {
      const runLength = countRun(text, i, '`');
      const close = findBacktickRun(text, i + runLength, runLength);
      if (close === -1) {
        buffer += '`'.repeat(runLength);
        i += runLength;
        continue;
      }
      flush();
      let code = text.slice(i + runLength, close);
      if (code !== ' ' && /^[ \n]/.test(code) && /[ \n]$/.test(code)) {
        code = code.slice(1, -1);
      }
      parts.push({ kind: 'inline', inline: textNode(code, [...marks, { type: 'code' }]) });
      i = close + runLength;
      continue;
    }
    if (char === '<') {
      const rest = text.slice(i);
      const autolink = rest.match(/^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/);
      if (autolink !== null) {
        const url = autolink[1]!;
        flush();
        parts.push({
          kind: 'inline',
          inline: textNode(url, [...marks, { type: 'link', attrs: { href: url, title: null } }]),
        });
        i += autolink[0].length;
        continue;
      }
      if (/^<(?:\/?[a-zA-Z][^<>]*>|!)/.test(rest)) {
        throw new ConversionError(`raw html is not supported (line ${line})`);
      }
      buffer += '<';
      i += 1;
      continue;
    }
    if (char === '!' && text[i + 1] === '[') {
      const image = parseLinkLike(text, i + 1, line);
      if (image !== null) {
        flush();
        const linkMark = marks.find((mark) => mark.type === 'link');
        parts.push({
          kind: 'inline',
          inline: {
            kind: 'image',
            src: image.destination,
            alt: image.label,
            title: image.title,
            href: linkMark === undefined ? null : (linkMark.attrs?.['href'] as string),
            line,
          },
        });
        i = image.end;
        continue;
      }
      buffer += '!';
      i += 1;
      continue;
    }
    if (char === '[') {
      if (text[i + 1] === '^') {
        throw new ConversionError(`footnote is not supported (line ${line})`);
      }
      const link = parseLinkLike(text, i, line);
      if (link !== null) {
        flush();
        const linkMark: PMMark = { type: 'link', attrs: { href: link.destination, title: link.title } };
        for (const piece of parseInlineRun(link.label, [...marks, linkMark], line)) {
          parts.push({ kind: 'inline', inline: piece });
        }
        i = link.end;
        continue;
      }
      buffer += '[';
      i += 1;
      continue;
    }
    if (char === '~' && text[i + 1] === '~') {
      const close = text.indexOf('~~', i + 2);
      const inner = close === -1 ? '' : text.slice(i + 2, close);
      if (close !== -1 && inner.trim() !== '') {
        flush();
        for (const piece of parseInlineRun(inner, [...marks, { type: 'strikethrough' }], line)) {
          parts.push({ kind: 'inline', inline: piece });
        }
        i = close + 2;
        continue;
      }
      buffer += '~~';
      i += 2;
      continue;
    }
    if (char === '*' || char === '_') {
      const runLength = countRun(text, i, char);
      const after = text[i + runLength];
      const before = i === 0 ? undefined : text[i - 1]!;
      const leftFlanking =
        !isWhitespace(after) && (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
      const rightFlanking =
        !isWhitespace(before) && (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));
      let canOpen = leftFlanking;
      let canClose = rightFlanking;
      if (char === '_') {
        canOpen = leftFlanking && (!rightFlanking || isPunctuation(before));
        canClose = rightFlanking && (!leftFlanking || isPunctuation(after));
      }
      flush();
      parts.push({ kind: 'delim', char, count: runLength, canOpen, canClose });
      i += runLength;
      continue;
    }
    buffer += char;
    i += 1;
  }
  flush();
  return processDelimiters(parts, marks, line);
}

/**
 * Pairs emphasis delimiter parts with a nearest-opener stack, the way
 * CommonMark does, so nested emphasis resolves innermost-first. Leftover
 * delimiter runs become literal text.
 */
function processDelimiters(parts: Part[], marks: PMMark[], line: number): Inline[] {
  const openers: number[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i]!;
    if (part.kind !== 'delim') {
      i += 1;
      continue;
    }
    if (!part.canClose) {
      if (part.canOpen) {
        openers.push(i);
      }
      i += 1;
      continue;
    }
    let openerIndex = -1;
    for (let k = openers.length - 1; k >= 0; k -= 1) {
      const candidate = parts[openers[k]!]!;
      if (candidate.kind === 'delim' && candidate.char === part.char && candidate.canOpen) {
        openerIndex = openers[k]!;
        break;
      }
    }
    if (openerIndex === -1) {
      if (part.canOpen) {
        openers.push(i);
      }
      i += 1;
      continue;
    }
    const opener = parts[openerIndex] as DelimPart;
    const use = opener.count >= 2 && part.count >= 2 ? 2 : 1;
    const mark: PMMark = use === 1 ? { type: 'em' } : { type: 'strong' };
    const spanParts = parts.slice(openerIndex + 1, i);
    const spanInline = applyMark(processDelimiters(spanParts, marks, line), mark);
    const openerLeft: Part | null =
      opener.count - use > 0
        ? { kind: 'delim', char: opener.char, count: opener.count - use, canOpen: opener.canOpen, canClose: false }
        : null;
    const closerLeft: Part | null =
      part.count - use > 0
        ? { kind: 'delim', char: part.char, count: part.count - use, canOpen: false, canClose: part.canClose }
        : null;
    const rebuilt: Part[] = [
      ...parts.slice(0, openerIndex),
      ...(openerLeft !== null ? [openerLeft] : []),
      ...spanInline.map((inline): Part => ({ kind: 'inline', inline })),
      ...(closerLeft !== null ? [closerLeft] : []),
      ...parts.slice(i + 1),
    ];
    parts.splice(0, parts.length, ...rebuilt);
    openers.length = 0;
    for (let k = 0; k < openerIndex; k += 1) {
      const candidate = parts[k]!;
      if (candidate.kind === 'delim' && candidate.canOpen) {
        openers.push(k);
      }
    }
    if (openerLeft !== null && openerLeft.canOpen) {
      openers.push(openerIndex);
    }
    i = openerIndex + (openerLeft !== null ? 1 : 0) + spanInline.length;
  }
  const inline: Inline[] = [];
  for (const part of parts) {
    if (part.kind === 'delim') {
      inline.push(textNode(part.char.repeat(part.count), marks));
      continue;
    }
    const node = part.inline as PMNode;
    if (node.type === 'text' && node.marks === undefined && marks.length > 0) {
      inline.push({ ...node, marks });
    } else {
      inline.push(part.inline);
    }
  }
  return inline;
}

function countRun(text: string, start: number, char: string): number {
  let length = 0;
  while (start + length < text.length && text[start + length] === char) {
    length += 1;
  }
  return length;
}

/** Prepends an emphasis mark to every text node of a resolved span, deduplicated. */
function applyMark(inline: Inline[], mark: PMMark): Inline[] {
  return inline.map((piece) => {
    if ((piece as PMNode).type !== 'text') {
      return piece;
    }
    const node = piece as PMNode;
    const current = node.marks ?? [];
    if (current.some((candidate) => candidate.type === mark.type)) {
      return node;
    }
    return { ...node, marks: [mark, ...current] };
  });
}

function findBacktickRun(text: string, from: number, length: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] !== '`') {
      i += 1;
      continue;
    }
    const runLength = countRun(text, i, '`');
    if (runLength === length) {
      return i;
    }
    i += runLength;
  }
  return -1;
}

interface LinkLike {
  label: string;
  destination: string;
  title: string | null;
  end: number;
}

/**
 * Parses `[label](destination "title")` starting at the opening bracket.
 * Returns null when the brackets do not form an inline link (the caller then
 * treats the bracket as literal text). Throws on reference-style links, which
 * the supported set rejects by name.
 */
function parseLinkLike(text: string, start: number, line: number): LinkLike | null {
  let depth = 0;
  let closeBracket = -1;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        closeBracket = i;
        break;
      }
    }
  }
  if (closeBracket === -1) {
    return null;
  }
  if (text[closeBracket + 1] === '[') {
    throw new ConversionError(`reference link is not supported (line ${line}): use inline links [text](url)`);
  }
  if (text[closeBracket + 1] !== '(') {
    return null;
  }
  const label = text.slice(start + 1, closeBracket);
  let i = closeBracket + 2;
  let destination = '';
  if (text[i] === '<') {
    const closeAngle = text.indexOf('>', i);
    if (closeAngle === -1) {
      return null;
    }
    destination = text.slice(i + 1, closeAngle);
    i = closeAngle + 1;
  } else {
    let parenDepth = 0;
    while (i < text.length) {
      const char = text[i]!;
      if (char === '\\' && PUNCTUATION.test(text[i + 1] ?? '')) {
        destination += text[i + 1]!;
        i += 2;
        continue;
      }
      if (char === '(') {
        parenDepth += 1;
      } else if (char === ')') {
        if (parenDepth === 0) {
          break;
        }
        parenDepth -= 1;
      } else if (/\s/.test(char) && parenDepth === 0) {
        break;
      }
      destination += char;
      i += 1;
    }
  }
  let title: string | null = null;
  while (i < text.length && /\s/.test(text[i]!)) {
    i += 1;
  }
  if (text[i] === '"' || text[i] === "'") {
    const quote = text[i]!;
    const closeQuote = text.indexOf(quote, i + 1);
    if (closeQuote === -1) {
      return null;
    }
    title = text.slice(i + 1, closeQuote);
    i = closeQuote + 1;
  }
  while (i < text.length && /\s/.test(text[i]!)) {
    i += 1;
  }
  if (text[i] !== ')' || destination === '') {
    return null;
  }
  return { label, destination, title, end: i + 1 };
}

function textNode(text: string, marks: PMMark[]): PMNode {
  return marks.length === 0 ? { type: 'text', text } : { type: 'text', text, marks };
}

function coalesce(inline: Inline[]): PMNode[] {
  const merged: PMNode[] = [];
  for (const piece of inline) {
    const node = piece as PMNode;
    const last = merged[merged.length - 1];
    if (
      node.type === 'text' &&
      last?.type === 'text' &&
      JSON.stringify(node.marks ?? []) === JSON.stringify(last.marks ?? [])
    ) {
      last.text = (last.text ?? '') + (node.text ?? '');
    } else {
      merged.push(node);
    }
  }
  return merged;
}
