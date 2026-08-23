import type { PMMark, PMNode, SubstackDocument } from './types.js';

/**
 * The slice of Substack's document schema this tool declares it can produce.
 * Every node the converter emits must satisfy these rules, and the command
 * validates the converted document against them locally before any request
 * would be sent.
 *
 * Sources for the node names and shapes: Substack's editor bundle (the
 * nodeSpec map ships minified inside it), the actively maintained
 * python-substack builders, and the Manticore write-up of round-tripping
 * drafts through the live editor. Names are Substack's own mix of snake_case
 * blocks (bullet_list, horizontal_rule) and camelCase (captionedImage).
 */
const BLOCK_NODES: Record<string, true> = {
  paragraph: true,
  heading: true,
  blockquote: true,
  bullet_list: true,
  ordered_list: true,
  list_item: true,
  highlighted_code_block: true,
  horizontal_rule: true,
  captionedImage: true,
  image2: true,
  caption: true,
};

const INLINE_NODES: Record<string, true> = { text: true, hard_break: true };

const MARKS: Record<string, true> = { strong: true, em: true, code: true, strikethrough: true, link: true };


const IMAGE2_ATTRS: Record<string, 'string' | 'string?' | 'boolean' | 'number?'> = {
  src: 'string',
  srcNoWatermark: 'string?',
  fullscreen: 'string?',
  imageSize: 'string?',
  height: 'number?',
  width: 'number?',
  resizeWidth: 'number?',
  bytes: 'number?',
  alt: 'string?',
  title: 'string?',
  type: 'string?',
  href: 'string?',
  belowTheFold: 'boolean',
  topImage: 'boolean',
  internalRedirect: 'string?',
  isProcessing: 'boolean',
  align: 'string?',
  offset: 'boolean',
};

/**
 * Validates a document against the declared schema. Returns one message per
 * violation, each prefixed with the path of the offending node. An empty
 * result means the document is valid.
 */
export function validateDocument(document: SubstackDocument): string[] {
  const violations: string[] = [];
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return ['$: document must be an object'];
  }
  if (document.type !== 'doc') {
    violations.push(`$: expected type "doc", got ${show(document.type)}`);
  }
  if (!Array.isArray(document.content) || document.content.length === 0) {
    violations.push('$.content: must be a non-empty array of block nodes');
    return violations;
  }
  document.content.forEach((node, index) => {
    validateNode(node, `$.content[${index}]`, violations);
  });
  return violations;
}

function validateNode(node: PMNode, path: string, violations: string[]): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    violations.push(`${path}: must be an object`);
    return;
  }
  if (!(node.type in BLOCK_NODES) && !(node.type in INLINE_NODES)) {
    violations.push(`${path}: unknown node type ${show(node.type)}`);
    return;
  }
  validateMarks(node.marks, path, violations);
  switch (node.type) {
    case 'text': {
      if (typeof node.text !== 'string') {
        violations.push(`${path}: text node requires a string "text"`);
      }
      if (node.content !== undefined) {
        violations.push(`${path}: text node must not have content`);
      }
      return;
    }
    case 'hard_break': {
      if (node.content !== undefined) {
        violations.push(`${path}: hard_break must not have content`);
      }
      return;
    }
    case 'paragraph':
    case 'caption':
      validateInlineContent(node, path, violations);
      return;
    case 'heading': {
      const level = node.attrs?.['level'];
      if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 6) {
        violations.push(`${path}: heading requires attrs.level in 1..6, got ${show(level)}`);
      }
      validateInlineContent(node, path, violations);
      return;
    }
    case 'highlighted_code_block': {
      const language = node.attrs?.['language'];
      const nodeId = node.attrs?.['nodeId'];
      if (typeof language !== 'string' || language === '') {
        violations.push(`${path}: highlighted_code_block requires a non-empty attrs.language`);
      }
      if (typeof nodeId !== 'string' && nodeId !== null) {
        violations.push(`${path}: highlighted_code_block attrs.nodeId must be a string or null`);
      }
      const content = node.content ?? [];
      for (const [index, child] of content.entries()) {
        const childPath = `${path}.content[${index}]`;
        if (child.type !== 'text') {
          violations.push(`${childPath}: highlighted_code_block may only contain text`);
        }
        if (child.marks !== undefined && child.marks.length > 0) {
          violations.push(`${childPath}: highlighted_code_block content forbids marks`);
        }
      }
      return;
    }
    case 'horizontal_rule': {
      if (node.content !== undefined) {
        violations.push(`${path}: horizontal_rule must not have content`);
      }
      return;
    }
    case 'bullet_list':
    case 'ordered_list': {
      if (node.type === 'ordered_list') {
        const order = node.attrs?.['order'];
        if (order !== undefined && (!Number.isInteger(order) || (order as number) < 1)) {
          violations.push(`${path}: ordered_list attrs.order must be a positive integer`);
        }
      }
      const content = node.content ?? [];
      if (content.length === 0 || content.some((child) => child.type !== 'list_item')) {
        violations.push(`${path}: ${node.type} requires one or more list_item children`);
        return;
      }
      content.forEach((child, index) => validateNode(child, `${path}.content[${index}]`, violations));
      return;
    }
    case 'list_item':
    case 'blockquote': {
      const content = node.content ?? [];
      if (content.length === 0) {
        violations.push(`${path}: ${node.type} requires at least one block child`);
        return;
      }
      for (const [index, child] of content.entries()) {
        if ((child.type in BLOCK_NODES) && child.type !== 'list_item') {
          validateNode(child, `${path}.content[${index}]`, violations);
        } else {
          violations.push(`${path}.content[${index}]: ${node.type} children must be blocks, got ${show(child.type)}`);
        }
      }
      return;
    }
    case 'captionedImage': {
      const content = node.content ?? [];
      if (content.length === 0 || content[0]?.type !== 'image2') {
        violations.push(`${path}: captionedImage requires an image2 as its first child`);
      }
      content.forEach((child, index) => {
        if (index > 0 && child.type !== 'caption') {
          violations.push(`${path}.content[${index}]: only caption may follow image2`);
        }
      });
      content.forEach((child, index) => validateNode(child, `${path}.content[${index}]`, violations));
      return;
    }
    case 'image2': {
      const attrs = node.attrs ?? {};
      for (const [name, kind] of Object.entries(IMAGE2_ATTRS)) {
        const value = attrs[name];
        const ok =
          kind === 'string'
            ? typeof value === 'string'
            : kind === 'boolean'
              ? typeof value === 'boolean'
              : kind === 'string?'
                ? typeof value === 'string' || value === null
                : value === null || typeof value === 'number';
        if (!ok) {
          violations.push(`${path}.attrs.${name}: expected ${kind}, got ${show(value)}`);
        }
      }
      if (node.content !== undefined) {
        violations.push(`${path}: image2 must not have content`);
      }
      return;
    }
    default:
      violations.push(`${path}: node type ${show(node.type)} is not part of the declared schema`);
  }
}

function validateInlineContent(node: PMNode, path: string, violations: string[]): void {
  for (const [index, child] of (node.content ?? []).entries()) {
    const childPath = `${path}.content[${index}]`;
    if (child.type in INLINE_NODES) {
      validateNode(child, childPath, violations);
    } else {
      violations.push(`${childPath}: ${node.type} may only contain inline nodes, got ${show(child.type)}`);
    }
  }
}

function validateMarks(marks: PMMark[] | undefined, path: string, violations: string[]): void {
  if (marks === undefined) {
    return;
  }
  if (!Array.isArray(marks)) {
    violations.push(`${path}: marks must be an array`);
    return;
  }
  for (const [index, mark] of marks.entries()) {
    if (!(mark.type in MARKS)) {
      violations.push(`${path}.marks[${index}]: unknown mark type ${show(mark.type)}`);
    }
    if (mark.type === 'link') {
      const href = mark.attrs?.['href'];
      if (typeof href !== 'string' || href === '') {
        violations.push(`${path}.marks[${index}]: link mark requires a non-empty attrs.href`);
      }
    } else if (mark.attrs !== undefined) {
      violations.push(`${path}.marks[${index}]: ${mark.type} mark takes no attrs`);
    }
  }
}

function show(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}
