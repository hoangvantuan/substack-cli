/**
 * The Substack document format: a ProseMirror tree stored as JSON. The node
 * and mark names below are the ones Substack's own editor schema declares,
 * verified against the editor bundle (see docs in the issue research); they
 * are deliberately not ProseMirror's default names.
 */

export interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface PMNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: PMMark[];
}

export interface SubstackDocument {
  type: 'doc';
  content: PMNode[];
}
