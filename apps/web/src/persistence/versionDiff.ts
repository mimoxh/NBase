import type { DocumentContent } from '../editor/types';

export interface DiffBlock {
  kind: string;
  text: string;
  checked?: boolean;
}

export interface DiffSpan {
  tone: 'keep' | 'add' | 'del';
  text: string;
}

export type DiffLine =
  | { type: 'keep' | 'add' | 'del'; block: DiffBlock }
  | { type: 'change'; block: DiffBlock; spans: DiffSpan[] };

const maxBlocks = 2000;
const maxChars = 200_000;

function textOf(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const record = node as { type?: string; text?: string; equation?: string; fileName?: string; children?: unknown[] };
  if (typeof record.text === 'string') return record.text;
  if (record.type === 'equation') return `[公式 ${record.equation ?? ''}]`;
  if (record.type === 'attachment') return `[附件 ${record.fileName ?? ''}]`;
  if (record.type === 'image-reference') return '[图片]';
  if (record.type === 'tab') return '\t';
  if (record.type === 'linebreak') return '\n';
  if (Array.isArray(record.children)) return record.children.map(textOf).join('');
  return '';
}

function blockFromNode(node: unknown, into: DiffBlock[]): void {
  const record = node as { type?: string; listType?: string; tag?: string; children?: unknown[] };
  if (!record || typeof record !== 'object') return;
  switch (record.type) {
    case 'paragraph': case 'quote': case 'code':
      into.push({ kind: record.type, text: textOf(node) });
      return;
    case 'heading':
      into.push({ kind: `h${record.tag ?? 1}`, text: textOf(node) });
      return;
    case 'list':
      for (const child of record.children ?? []) {
        const item = child as { type?: string; checked?: boolean };
        if (item?.type === 'listitem') {
          into.push({ kind: record.listType === 'check' ? 'todo' : record.listType === 'number' ? 'ol' : 'ul',
            text: textOf(item), ...(record.listType === 'check' ? { checked: Boolean(item.checked) } : {}) });
        }
      }
      return;
    case 'table':
      for (const row of record.children ?? []) {
        const cells = (row as { children?: unknown[] }).children ?? [];
        into.push({ kind: 'table', text: cells.map(textOf).join(' | ') });
      }
      return;
    case 'horizontalrule':
      into.push({ kind: 'hr', text: '' });
      return;
    default:
      into.push({ kind: record.type ?? 'block', text: textOf(node) });
  }
}

/** Flattens versioned content into comparable text blocks (one per list item / table row). */
export function extractBlocks(content: DocumentContent): DiffBlock[] {
  const root = content.editorState?.root as { children?: unknown[] } | undefined;
  const blocks: DiffBlock[] = [];
  for (const child of root?.children ?? []) blockFromNode(child, blocks);
  return blocks;
}

/** Longest-common-subsequence matrix + alignment: match[i][j] marks aligned positions. */
function lcs(a: string[], b: string[]): { match: boolean[][]; length: number[][] } {
  const rows = a.length + 1; const cols = b.length + 1;
  const length: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      length[i]![j] = a[i] === b[j] ? length[i + 1]![j + 1]! + 1 : Math.max(length[i + 1]![j]!, length[i]![j + 1]!);
    }
  }
  const match = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { match[i]![j] = true; i += 1; j += 1; }
    else if (length[i + 1]![j]! >= length[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return { match, length };
}

/** Character-level alignment used for paired block changes. */
export function charSpans(before: string, after: string): DiffSpan[] {
  const a = [...before]; const b = [...after];
  const { match, length } = lcs(a, b);
  const spans: DiffSpan[] = [];
  const emit = (tone: DiffSpan['tone'], text: string) => {
    if (!text) return;
    const last = spans.at(-1);
    if (last && last.tone === tone) last.text += text;
    else spans.push({ tone, text });
  };
  let i = 0; let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && match[i]![j]) { emit('keep', a[i]!); i += 1; j += 1; }
    else if (i < a.length && (j >= b.length || length[i + 1]![j]! >= length[i]![j + 1]!)) { emit('del', a[i]!); i += 1; }
    else if (j < b.length) { emit('add', b[j]!); j += 1; }
    else i += 1;
  }
  return spans;
}

function commonLength(a: string[], b: string[]): number {
  const { match } = lcs(a, b);
  let count = 0;
  for (let i = 0; i < a.length; i += 1) for (let j = 0; j < b.length; j += 1) if (match[i]?.[j]) count += 1;
  return count;
}

export interface VersionDiff {
  lines: DiffLine[];
  tooLarge: boolean;
}

/** Block-level diff; adjacent same-kind del+add pairs with ≥15% char-LCS overlap become one inline diff. */
export function diffVersions(oldContent: DocumentContent, newContent: DocumentContent): VersionDiff {
  const before = extractBlocks(oldContent);
  const after = extractBlocks(newContent);
  const chars = before.concat(after).reduce((sum, block) => sum + block.text.length, 0);
  if (before.length + after.length > maxBlocks || chars > maxChars) return { lines: [], tooLarge: true };

  const key = (block: DiffBlock) => `${block.kind}:${block.checked ?? ''}:${block.text}`;
  const a = before.map(key); const b = after.map(key);
  const { match, length } = lcs(a, b);
  const lines: DiffLine[] = [];
  let i = 0; let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && match[i]![j]) {
      lines.push({ type: 'keep', block: before[i]! }); i += 1; j += 1; continue;
    }
    // Walk the non-match run with the LCS direction rule so keeps are never skipped.
    const runI = i; const runJ = j;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && match[i]![j]) break;
      if (i < a.length && (j >= b.length || length[i + 1]![j]! >= length[i]![j + 1]!)) i += 1;
      else j += 1;
    }
    const dels = before.slice(runI, i);
    const adds = after.slice(runJ, j);
    const usedAdd = new Set<number>();
    for (const del of dels) {
      let best = -1; let bestRatio = 0;
      for (let k = 0; k < adds.length; k += 1) {
        const candidate = adds[k]!;
        if (usedAdd.has(k) || candidate.kind !== del.kind) continue;
        const longer = Math.max(del.text.length, candidate.text.length, 1);
        const ratio = commonLength([...del.text], [...candidate.text]) / longer;
        if (ratio > bestRatio) { bestRatio = ratio; best = k; }
      }
      if (best >= 0 && bestRatio >= 0.15) {
        usedAdd.add(best);
        const added = adds[best]!;
        lines.push({ type: 'change', block: added, spans: charSpans(del.text, added.text) });
      } else lines.push({ type: 'del', block: del });
    }
    adds.forEach((add, k) => { if (!usedAdd.has(k)) lines.push({ type: 'add', block: add }); });
  }
  return { lines, tooLarge: false };
}
