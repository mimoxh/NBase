import type { StoredDocumentContent } from '@nbase/contracts';

/**
 * Exporters walk the stored Lexical JSON, never live editor state. Every field is read
 * defensively: content may come from a newer stage (unknown node types or keys) and an
 * exporter must degrade to visible text instead of throwing or dropping words.
 */
export type SerializedNode = Record<string, unknown>;

export const TEXT_FORMAT = {
  bold: 1, italic: 2, strikethrough: 4, underline: 8, code: 16, subscript: 32, superscript: 64, highlight: 128,
} as const;

const maxDepth = 96;

export const isNode = (value: unknown): value is SerializedNode =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const typeOf = (node: SerializedNode): string => typeof node.type === 'string' ? node.type : '';
export const str = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
export const int = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
export const childrenOf = (node: SerializedNode): SerializedNode[] =>
  Array.isArray(node.children) ? node.children.filter(isNode) : [];
export const rootOf = (content: StoredDocumentContent): SerializedNode => {
  const state = (content as { editorState?: unknown }).editorState;
  const root = isNode(state) ? state.root : undefined;
  return isNode(root) ? root : { type: 'root', children: [] };
};
export const hasFormat = (node: SerializedNode, bit: number): boolean => (int(node.format, 0) & bit) !== 0;

const numericAlign: Record<number, string> = { 2: 'center', 3: 'right', 4: 'justify' };
/** Only the alignments NBase writes; `start`/`left` and unknown values read as the default. */
export function blockAlign(node: SerializedNode): 'center' | 'right' | 'justify' | null {
  const value = typeof node.format === 'number' ? numericAlign[node.format] : node.format;
  return value === 'center' || value === 'right' || value === 'justify' ? value : null;
}

/** Nodes whose children are inline content rather than blocks. */
export const INLINE_CONTAINERS = new Set(['paragraph', 'heading', 'quote', 'link', 'autolink', 'listitem', 'code']);
export const INLINE_LEAVES = new Set(['text', 'code-highlight', 'linebreak', 'tab', 'image-reference', 'attachment',
  'equation', 'page-reference', 'footnote-reference', 'block-reference']);

/** Text a reader would see; used for unknown nodes and for fallbacks when a renderer fails. */
export function visibleText(node: SerializedNode, depth = 0): string {
  if (depth > maxDepth) return '';
  switch (typeOf(node)) {
    case 'linebreak': return '\n';
    case 'tab': return '\t';
    case 'equation': return str(node.equation);
    case 'page-reference': return str(node.label);
    case 'footnote-reference': return `[^${str(node.footnoteId)}]`;
    case 'attachment': return str(node.fileName) || str(node.alt);
    case 'mermaid': return str(node.source);
    case 'bookmark': return [str(node.title), str(node.url)].filter(Boolean).join(' ');
    case 'image-reference': return str(node.alt) || str(node.text);
    default: break;
  }
  if (typeof node.text === 'string') return node.text;
  const children = childrenOf(node);
  if (!children.length) {
    for (const key of ['label', 'title', 'textContent', 'content', 'source']) if (typeof node[key] === 'string') return node[key] as string;
    return '';
  }
  const blocks = children.some(child => !INLINE_LEAVES.has(typeOf(child)) && childrenOf(child).length > 0
    && !['link', 'autolink'].includes(typeOf(child)));
  return children.map(child => visibleText(child, depth + 1)).join(blocks ? '\n' : '');
}

/** Code block text: highlight tokens, line breaks and tabs flattened back to source. */
export function codeText(node: SerializedNode): string {
  return childrenOf(node).map(child => {
    const type = typeOf(child);
    if (type === 'linebreak') return '\n';
    if (type === 'tab') return '\t';
    return visibleText(child);
  }).join('');
}

export interface FootnoteIndex {
  /** Display order: first reference order, then definitions nobody references. */
  order: string[];
  definitions: Map<string, SerializedNode>;
  referenced: Set<string>;
}

export function indexFootnotes(root: SerializedNode): FootnoteIndex {
  const definitions = new Map<string, SerializedNode>();
  const order: string[] = [];
  const referenced = new Set<string>();
  const visit = (node: SerializedNode, depth: number): void => {
    if (depth > maxDepth) return;
    const type = typeOf(node);
    if (type === 'footnote-definition' && !definitions.has(str(node.footnoteId))) definitions.set(str(node.footnoteId), node);
    if (type === 'footnote-reference' && !referenced.has(str(node.footnoteId))) { referenced.add(str(node.footnoteId)); order.push(str(node.footnoteId)); }
    childrenOf(node).forEach(child => visit(child, depth + 1));
  };
  visit(root, 0);
  for (const id of definitions.keys()) if (!referenced.has(id)) order.push(id);
  return { order, definitions, referenced };
}

export interface AttachmentRef { id: string; fileName: string; mediaType: string }

export function attachmentNodes(root: SerializedNode): AttachmentRef[] {
  const found = new Map<string, AttachmentRef>();
  const visit = (node: SerializedNode, depth: number): void => {
    if (depth > maxDepth) return;
    if (typeOf(node) === 'attachment' && typeof node.attachmentId === 'string')
      found.set(node.attachmentId.toLowerCase(), { id: node.attachmentId.toLowerCase(), fileName: str(node.fileName, '附件'), mediaType: str(node.mediaType) });
    childrenOf(node).forEach(child => visit(child, depth + 1));
  };
  visit(root, 0);
  return [...found.values()];
}

export function mermaidSources(root: SerializedNode): string[] {
  const found = new Set<string>();
  const visit = (node: SerializedNode, depth: number): void => {
    if (depth > maxDepth) return;
    if (typeOf(node) === 'mermaid' && typeof node.source === 'string' && node.source.trim()) found.add(node.source);
    childrenOf(node).forEach(child => visit(child, depth + 1));
  };
  visit(root, 0);
  return [...found];
}

export interface GridCell { cell: SerializedNode; row: number; col: number; colSpan: number; rowSpan: number; header: boolean }
export interface TableLayout {
  columns: number;
  /** Cells by origin row, in column order. */
  rows: GridCell[][];
  /** Cell covering (row, col), whether it starts there or not. */
  at: (row: number, col: number) => GridCell | undefined;
  colWidths: number[] | null;
}

/** Places merged cells on a rectangular grid, the way HTML tables flow cells around row spans. */
export function tableLayout(table: SerializedNode): TableLayout {
  const rows = childrenOf(table).filter(row => typeOf(row) === 'tablerow');
  const cover = new Map<string, GridCell>();
  let columns = 0;
  const placed = rows.map((row, r) => {
    let col = 0;
    return childrenOf(row).filter(cell => typeOf(cell) === 'tablecell').map(cell => {
      while (cover.has(`${r}:${col}`)) col++;
      const colSpan = Math.min(Math.max(int(cell.colSpan, 1), 1), 64);
      const rowSpan = Math.min(Math.max(int(cell.rowSpan, 1), 1), rows.length - r);
      const item: GridCell = { cell, row: r, col, colSpan, rowSpan, header: (int(cell.headerState, 0) & 1) !== 0 || (int(cell.headerState, 0) & 2) !== 0 };
      for (let y = 0; y < rowSpan; y++) for (let x = 0; x < colSpan; x++) cover.set(`${r + y}:${col + x}`, item);
      col += colSpan;
      columns = Math.max(columns, col);
      return item;
    });
  });
  for (const key of cover.keys()) columns = Math.max(columns, Number(key.split(':')[1]) + 1);
  const widths = Array.isArray(table.colWidths) && table.colWidths.length
    && table.colWidths.every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
    ? (table.colWidths as number[]).slice(0, Math.max(columns, 1)) : null;
  return { columns, rows: placed, at: (row, col) => cover.get(`${row}:${col}`), colWidths: widths };
}

export const isRowHeader = (cell: SerializedNode) => (int(cell.headerState, 0) & 1) !== 0;

/** Lets the tab paint between heavy steps (attachment reads, diagram renders, base64). */
export const yieldToBrowser = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
