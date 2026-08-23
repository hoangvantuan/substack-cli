import type { Env } from '../env/types.js';
import type { SubstackClient } from './api.js';

/**
 * Sleep inserted between two consecutive uploads so a post with many local
 * images stays under the rate limits. The last upload is not followed by a
 * sleep; unit tests observe the pacing through env.sleep.
 */
export const IMAGE_UPLOAD_PACE_MS = 500;

/** Extensions this tool knows a content type for; anything else uploads as octet-stream. */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
}

/**
 * True when an image src points at something this tool must upload before
 * sending: every src that is not already an http(s) URL (relative paths,
 * absolute paths, file:// URIs).
 */
export function isLocalImageSrc(src: unknown): src is string {
  return typeof src === 'string' && !/^https?:\/\//i.test(src);
}

/**
 * Turns an image src into a filesystem path relative to the directory of the
 * Markdown file being sent. `file://` URIs are unwrapped, absolute paths are
 * kept, and anything else resolves against baseDir.
 */
export function resolveImageSrc(src: string, baseDir: string): string {
  const unwrapped = src.startsWith('file://') ? decodeURI(src.slice('file://'.length)) : src;
  if (unwrapped.startsWith('/')) {
    return unwrapped;
  }
  // A leading './' is Markdown noise; drop it so the join stays a clean path
  // even when baseDir is '.', where a naive join would produce './name'.
  return `${baseDir.replace(/\/$/, '')}/${unwrapped.replace(/^\.\//, '')}`.replace(/^\.\//, '');
}


/** The directory part of a POSIX path ('.' when the path has none). */
export function dirnameOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '.' : cut === 0 ? '/' : path.slice(0, cut);
}

/** One image reference in the document that the send flow may have to rewrite. */
interface PlannedUpload {
  node: PMNode;
  /** The src exactly as written in the document, for error messages. */
  src: string;
  path: string;
}

function collectImageNodes(node: PMNode, out: PMNode[]): void {
  if (node.type === 'captionedImage' || node.type === 'image2') {
    out.push(node);
  }
  for (const child of node.content ?? []) {
    collectImageNodes(child, out);
  }
}

/** The distinct local image srcs the document still references, in document order. */
export function localImageSources(document: PMNode): string[] {
  const nodes: PMNode[] = [];
  collectImageNodes(document, nodes);
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const node of nodes) {
    const src = node.attrs?.['src'];
    if (!isLocalImageSrc(src) || seen.has(src)) {
      continue;
    }
    seen.add(src);
    sources.push(src);
  }
  return sources;
}

/**
 * Uploads every local image the document references and rewrites its image2
 * src to the hosted URL, in place. Files are checked first so a missing one
 * stops the command with a clear naming error before any draft exists or a
 * single byte is uploaded. Consecutive uploads of distinct files are paced
 * through env.sleep; repeats of an already-uploaded file are free.
 *
 * Returns the number of uploads performed.
 */
export async function uploadLocalImages(
  env: Env,
  client: SubstackClient,
  document: PMNode,
  baseDir: string,
): Promise<number> {
  const nodes: PMNode[] = [];
  collectImageNodes(document, nodes);
  const planned: PlannedUpload[] = [];
  for (const node of nodes) {
    const src = node.attrs?.['src'];
    if (isLocalImageSrc(src)) {
      planned.push({ node, src, path: resolveImageSrc(src, baseDir) });
    }
  }
  for (const entry of planned) {
    if (!(await env.fs.exists(entry.path))) {
      throw new Error(
        `local image not found: ${entry.path} (referenced in the post body as "${entry.src}")`,
      );
    }
  }
  let uploaded = 0;
  const hostedByPath = new Map<string, string>();
  for (const entry of planned) {
    const cached = hostedByPath.get(entry.path);
    if (cached !== undefined) {
      entry.node.attrs!['src'] = cached;
      continue;
    }
    if (uploaded > 0) {
      await env.sleep(IMAGE_UPLOAD_PACE_MS);
    }
    const hosted = await client.uploadImage(await toDataUri(env, entry.path));
    entry.node.attrs!['src'] = hosted.url;
    hostedByPath.set(entry.path, hosted.url);
    uploaded += 1;
  }
  return uploaded;
}

async function toDataUri(env: Env, path: string): Promise<string> {
  const { readFileBase64 } = env.fs;
  if (readFileBase64 === undefined) {
    throw new Error(`cannot read ${path}: this environment cannot read binary files`);
  }
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const contentType = CONTENT_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream';
  return `data:${contentType};base64,${await readFileBase64(path)}`;
}
