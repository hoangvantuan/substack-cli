/**
 * Converts Substack post body HTML to Markdown.
 *
 * The converter covers the tag set the Substack editor emits: paragraphs,
 * h2-h4 headings (shifted one level up, mirroring the publishing offset
 * recorded in ADR 0003), emphasis, links, lists, blockquotes, code, rules,
 * breaks, and figures. Block tags outside that set are embedded verbatim,
 * since Markdown renders embedded HTML. Images keep their original URLs.
 */

export interface MarkdownOptions {
  /** Base used to resolve protocol-relative and root-relative image URLs. */
  baseUrl?: string;
}

interface ElementNode {
  kind: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  start: number;
  end: number;
}

interface TextNode {
  kind: 'text';
  text: string;
  start: number;
  end: number;
}

type Node = ElementNode | TextNode;

const VOID_TAGS: Record<string, true> = {
  area: true, base: true, br: true, col: true, embed: true, hr: true, img: true,
  input: true, link: true, meta: true, param: true, source: true, track: true, wbr: true,
};

const RAW_TEXT_TAGS: Record<string, true> = { script: true, style: true };

const HEADING_TAGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** Converts body HTML to a Markdown string without a trailing newline. */
export function htmlToMarkdown(html: string, options: MarkdownOptions = {}): string {
  const blocks = renderBlocks(parseHtml(html), html, options);
  return blocks.filter((block) => block.trim() !== '').join('\n\n');
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Parses HTML into a tree. Tolerant of stray closing tags and raw text. */
export function parseHtml(html: string): Node[] {
  const root: Node[] = [];
  const stack: ElementNode[] = [];
  const append = (node: Node): void => {
    const parent = stack.length > 0 ? stack[stack.length - 1] : undefined;
    (parent === undefined ? root : parent.children).push(node);
  };
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf('<', i);
    if (open === -1) {
      append(textNode(html.slice(i), i, html.length));
      break;
    }
    if (open > i) append(textNode(html.slice(i, open), i, open));
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    const bang = html.charAt(open + 1);
    if (bang === '!' || bang === '?') {
      const close = html.indexOf('>', open);
      i = close === -1 ? html.length : close + 1;
      continue;
    }
    if (bang === '/') {
      const close = html.indexOf('>', open);
      if (close === -1) break;
      const name = html.slice(open + 2, close).trim().toLowerCase();
      i = close + 1;
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (stack[depth]!.tag === name) {
          stack[depth]!.end = i;
          stack.length = depth;
          break;
        }
      }
      continue;
    }
    const parsed = parseTag(html, open);
    if (parsed === null) {
      append(textNode('<', open, open + 1));
      i = open + 1;
      continue;
    }
    const node: ElementNode = {
      kind: 'element',
      tag: parsed.tag,
      attrs: parsed.attrs,
      children: [],
      start: open,
      end: parsed.end,
    };
    append(node);
    i = parsed.end;
    if (RAW_TEXT_TAGS[parsed.tag] === true) {
      const closeStart = html.toLowerCase().indexOf(`</${parsed.tag}`, i);
      const textEnd = closeStart === -1 ? html.length : closeStart;
      if (textEnd > i) node.children.push(textNode(html.slice(i, textEnd), i, textEnd));
      const close = html.indexOf('>', textEnd);
      node.end = close === -1 ? html.length : close + 1;
      i = node.end;
      continue;
    }
    if (parsed.selfClosing || VOID_TAGS[parsed.tag] === true) continue;
    stack.push(node);
  }
  for (const node of stack) node.end = html.length;
  return root;
}

interface ParsedTag {
  tag: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  end: number;
}

function parseTag(html: string, start: number): ParsedTag | null {
  let i = start + 1;
  let name = '';
  while (i < html.length && /[a-zA-Z0-9]/.test(html.charAt(i))) {
    name += html.charAt(i);
    i += 1;
  }
  if (name === '') return null;
  const attrs: Record<string, string> = {};
  let selfClosing = false;
  for (;;) {
    while (i < html.length && /\s/.test(html.charAt(i))) i += 1;
    if (i >= html.length) return { tag: name.toLowerCase(), attrs, selfClosing, end: i };
    const current = html.charAt(i);
    if (current === '>') {
      i += 1;
      break;
    }
    if (current === '/') {
      if (html.charAt(i + 1) === '>') {
        selfClosing = true;
        i += 2;
        break;
      }
      i += 1;
      continue;
    }
    let attrName = '';
    while (i < html.length && !/[\s=>/]/.test(html.charAt(i))) {
      attrName += html.charAt(i);
      i += 1;
    }
    if (attrName === '') {
      i += 1;
      continue;
    }
    while (i < html.length && /\s/.test(html.charAt(i))) i += 1;
    let value = '';
    if (html.charAt(i) === '=') {
      i += 1;
      while (i < html.length && /\s/.test(html.charAt(i))) i += 1;
      const quote = html.charAt(i);
      if (quote === '"' || quote === "'") {
        i += 1;
        const close = html.indexOf(quote, i);
        const stop = close === -1 ? html.length : close;
        value = html.slice(i, stop);
        i = close === -1 ? html.length : close + 1;
      } else {
        while (i < html.length && !/[\s>]/.test(html.charAt(i))) {
          value += html.charAt(i);
          i += 1;
        }
      }
    }
    attrs[attrName.toLowerCase()] = decodeEntities(value);
  }
  return { tag: name.toLowerCase(), attrs, selfClosing, end: i };
}

function textNode(raw: string, start: number, end: number): TextNode {
  return { kind: 'text', text: decodeEntities(raw), start, end };
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', micro: 'µ',
  cent: '¢', pound: '£', euro: '€', yen: '¥', sect: '§', para: '¶',
  middot: '·', bull: '•', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  laquo: '«', raquo: '»', times: '×', divide: '÷', minus: '−',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
  dagger: '†', Dagger: '‡', prime: '′', Prime: '″',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û',
  atilde: 'ã', ntilde: 'ñ', otilde: 'õ', ccedil: 'ç', uml: '¨',
  auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', szlig: 'ß',
  Aring: 'Å', aring: 'å', oslash: 'ø', Oslash: 'Ø', æ: 'æ', Æ: 'Æ', å: 'å',
};

/** Decodes numeric and the common named HTML entities. */
export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body.charAt(1) === 'x' || body.charAt(1) === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return codePointText(code);
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function codePointText(code: number): string {
  if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function renderBlocks(nodes: Node[], source: string, options: MarkdownOptions): string[] {
  const blocks: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'text') {
      const md = renderInline([node], source, options);
      if (md.trim() !== '') blocks.push(escapeLeadingHash(md));
      continue;
    }
    switch (node.tag) {
      case 'p': {
        const md = renderInline(node.children, source, options);
        if (md.trim() !== '') blocks.push(escapeLeadingHash(md));
        break;
      }
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const level = Math.max(1, HEADING_TAGS[node.tag]! - 1);
        const md = renderInline(node.children, source, options).trim();
        if (md !== '') blocks.push('#'.repeat(level) + ' ' + md);
        break;
      }
      case 'ul':
      case 'ol': {
        const lines = renderList(node, '', source, options);
        if (lines.length > 0) blocks.push(lines.join('\n'));
        break;
      }
      case 'blockquote': {
        const inner = renderBlocks(node.children, source, options).join('\n\n');
        if (inner.trim() !== '') {
          blocks.push(inner.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n'));
        }
        break;
      }
      case 'pre':
        blocks.push(renderPre(node));
        break;
      case 'hr':
        blocks.push('---');
        break;
      case 'figure':
        blocks.push(...renderFigure(node, source, options));
        break;
      case 'img':
        blocks.push(imageMarkdown(node, options));
        break;
      case 'div': {
        // Image containers and unclassed wrappers hold ordinary blocks;
        // anything else (embeds, callouts, comments) stays verbatim.
        const cls = node.attrs['class'] ?? '';
        if (cls === '' || cls.includes('captioned-image-container')) {
          blocks.push(...renderBlocks(node.children, source, options));
        } else {
          const raw = rawSlice(node, source);
          if (raw.trim() !== '') blocks.push(raw);
        }
        break;
      }
      default: {
        const raw = rawSlice(node, source);
        if (raw.trim() !== '') blocks.push(raw);
      }
    }
  }
  return blocks;
}

function renderFigure(node: ElementNode, source: string, options: MarkdownOptions): string[] {
  const img = findDescendant(
    node,
    (child) => child.tag === 'img' && (child.attrs['src'] ?? '') !== '',
  );
  if (img === null) return [rawSlice(node, source)];
  const blocks = [imageMarkdown(img, options)];
  const caption = findDescendant(node, (child) => child.tag === 'figcaption');
  if (caption !== null) {
    const text = renderInline(caption.children, source, options).trim();
    if (text !== '') blocks.push(`*${text}*`);
  }
  return blocks;
}

function renderList(node: ElementNode, indent: string, source: string, options: MarkdownOptions): string[] {
  const ordered = node.tag === 'ol';
  let counter = 1;
  const startRaw = node.attrs['start'];
  if (ordered && startRaw !== undefined && /^\d+$/.test(startRaw)) counter = Number(startRaw);
  const lines: string[] = [];
  for (const child of node.children) {
    if (child.kind !== 'element') continue;
    if (child.tag === 'li') {
      const marker = ordered ? `${counter}. ` : '- ';
      counter += 1;
      lines.push(...renderListItem(child, marker, indent, source, options));
    } else if (child.tag === 'ul' || child.tag === 'ol') {
      lines.push(...renderList(child, indent + '  ', source, options));
    }
  }
  return lines;
}

function renderListItem(
  node: ElementNode,
  marker: string,
  indent: string,
  source: string,
  options: MarkdownOptions,
): string[] {
  const inlineNodes: Node[] = [];
  const nested: ElementNode[] = [];
  for (const child of node.children) {
    if (child.kind === 'element' && (child.tag === 'ul' || child.tag === 'ol')) nested.push(child);
    else inlineNodes.push(child);
  }
  const contentIndent = indent + ' '.repeat(marker.length);
  const head = renderInline(inlineNodes, source, options).trim();
  const lines: string[] = [indent + marker + (head.split('\n')[0] ?? '')];
  for (const line of head.split('\n').slice(1)) lines.push(contentIndent + line);
  for (const list of nested) lines.push(...renderList(list, contentIndent, source, options));
  const last = lines.length - 1;
  lines[last] = lines[last]!.replace(/[ \t]+$/, '');
  return lines;
}

function renderPre(node: ElementNode): string {
  const content = textContent(node.children).replace(/^\n+/, '').replace(/\n+$/, '');
  let language = '';
  const code = findDescendant(node, (child) => child.tag === 'code');
  if (code !== null) {
    const match = /(?:^|\s)language-([^\s]+)/.exec(code.attrs['class'] ?? '');
    if (match !== null) language = match[1]!;
  }
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

function renderInline(nodes: Node[], source: string, options: MarkdownOptions): string {
  let out = '';
  const emit = (segment: string): void => {
    if (segment === '') return;
    if (out.endsWith(' ') && segment.startsWith(' ')) segment = segment.slice(1);
    out += segment;
  };
  for (const node of nodes) {
    if (node.kind === 'text') {
      emit(escapeText(node.text.replace(/[ \t\r\n\f]+/g, ' ')));
      continue;
    }
    switch (node.tag) {
      case 'strong':
      case 'b':
        emit(wrapInline(node, '**', source, options));
        break;
      case 'em':
      case 'i':
        emit(wrapInline(node, '*', source, options));
        break;
      case 'code':
        emit(codeSpan(node));
        break;
      case 'br':
        emit('  \n');
        break;
      case 'a':
        emit(renderLink(node, source, options));
        break;
      case 'img':
        emit(imageMarkdown(node, options));
        break;
      case 'span':
      case 'p':
        // Transparent inline wrappers: a paragraph inside a list item holds
        // inline content, not a nested block.
        emit(renderInline(node.children, source, options));
        break;
      default:
        emit(rawSlice(node, source));
    }
  }
  return out;
}

function wrapInline(
  node: ElementNode,
  marker: string,
  source: string,
  options: MarkdownOptions,
): string {
  const inner = renderInline(node.children, source, options);
  const core = inner.trim();
  if (core === '') return '';
  const lead = inner.startsWith(' ') ? ' ' : '';
  const trail = inner.endsWith(' ') ? ' ' : '';
  return `${lead}${marker}${core}${marker}${trail}`;
}

function renderLink(node: ElementNode, source: string, options: MarkdownOptions): string {
  const inner = renderInline(node.children, source, options);
  const href = node.attrs['href'];
  // An image link lets the image stand alone; the wrapper adds nothing.
  if (href === undefined || href === '' || findDescendant(node, (child) => child.tag === 'img') !== null) {
    return inner;
  }
  const core = inner.trim();
  if (core === '') return inner;
  const lead = inner.startsWith(' ') ? ' ' : '';
  const trail = inner.endsWith(' ') ? ' ' : '';
  return `${lead}[${core}](${hrefForm(href)})${trail}`;
}

function codeSpan(node: ElementNode): string {
  const content = textContent(node.children);
  const fence = '`'.repeat(longestBacktickRun(content) + 1);
  const padded = content.startsWith('`') || content.endsWith('`') ? ` ${content} ` : content;
  return `${fence}${padded}${fence}`;
}

function imageMarkdown(node: ElementNode, options: MarkdownOptions): string {
  const alt = (node.attrs['alt'] ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/[[\]]/g, (char) => `\\${char}`);
  return `![${alt}](${hrefForm(resolveUrl(node.attrs['src'] ?? '', options))})`;
}

function resolveUrl(raw: string, options: MarkdownOptions): string {
  if (raw === '') return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  if (raw.startsWith('/') && options.baseUrl !== undefined) {
    return `${options.baseUrl.replace(/\/+$/, '')}${raw}`;
  }
  return raw;
}

function hrefForm(href: string): string {
  return href.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function rawSlice(node: ElementNode, source: string): string {
  return source.slice(node.start, node.end);
}

function findDescendant(root: ElementNode, predicate: (node: ElementNode) => boolean): ElementNode | null {
  for (const child of root.children) {
    if (child.kind !== 'element') continue;
    if (predicate(child)) return child;
    const found = findDescendant(child, predicate);
    if (found !== null) return found;
  }
  return null;
}

function textContent(nodes: Node[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') out += node.text;
    else if (RAW_TEXT_TAGS[node.tag] !== true) out += textContent(node.children);
  }
  return out;
}


function escapeText(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, '\\$1');
}

function escapeLeadingHash(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => line.replace(/^(\s*)#/, '$1\\#'))
    .join('\n');
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}
