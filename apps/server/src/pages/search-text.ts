import type { StoredDocumentContent } from '@nbase/contracts';

const separatingElements = new Set(['paragraph', 'heading', 'quote', 'listitem', 'code', 'tablecell']);

/** Flatten validated Lexical JSON without adding spaces between adjacent formatted text leaves. */
export function extractSearchText(content: StoredDocumentContent): string {
  const pieces: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 64) return;
    const value = node as Record<string, unknown>;
    if (value.type === 'equation') {
      if (typeof value.equation === 'string') pieces.push(` ${value.equation} `);
    } else if (value.type === 'attachment') {
      if (typeof value.fileName === 'string') pieces.push(` ${value.fileName} `);
      if (typeof value.alt === 'string' && value.alt !== value.fileName) pieces.push(` ${value.alt} `);
    } else if (typeof value.text === 'string') pieces.push(value.text);
    if (Array.isArray(value.children)) value.children.forEach(child => visit(child, depth + 1));
    if (separatingElements.has(String(value.type))) pieces.push(' ');
  };
  visit(content.editorState.root, 0);
  return pieces.join('').replace(/\s+/gu, ' ').trim();
}
