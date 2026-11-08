import { describe, expect, it } from 'vitest';
import { createContentFromMarkdown, markdownFromContent } from './markdown';
import { parseSourceEdit, prepareSourceEdit } from './sourceEditing';
import type { DocumentContent } from './types';

const databaseId = '0b6f2c1e-5d3a-4e7b-9a10-1c2d3e4f5a99';
const viewId = '0b6f2c1e-5d3a-4e7b-9a10-1c2d3e4f5a98';

function withBlock(view: string | null): DocumentContent {
  return { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, format: '', indent: 0, direction: null, children: [
    { type: 'paragraph', version: 1, format: '', indent: 0, direction: null, textFormat: 0, textStyle: '', children: [
      { type: 'text', version: 1, text: '前文', format: 0, detail: 0, mode: 'normal', style: '' }] },
    { type: 'database-view', version: 1, databaseId, viewId: view },
    { type: 'paragraph', version: 1, format: '', indent: 0, direction: null, textFormat: 0, textStyle: '', children: [
      { type: 'text', version: 1, text: '后文', format: 0, detail: 0, mode: 'normal', style: '' }] },
  ] } } } as unknown as DocumentContent;
}

describe('database view blocks in Markdown', () => {
  it('exports a link line and imports it back as a block', () => {
    const markdown = markdownFromContent(withBlock(viewId));
    expect(markdown).toContain(`[数据库视图](/?page=${databaseId}#nbase-database-view=${viewId})`);
    const imported = createContentFromMarkdown(markdown);
    const nodes = (imported.editorState.root as unknown as { children: { type: string; databaseId?: string; viewId?: string }[] }).children;
    expect(nodes.find(node => node.type === 'database-view')).toMatchObject({ databaseId, viewId });
  });

  it('keeps the block through protected source editing', () => {
    for (const view of [viewId, null]) {
      const preparation = prepareSourceEdit(withBlock(view));
      expect(preparation.diagnostics).toEqual([]);
      expect(preparation.canApply).toBe(true);
      const result = parseSourceEdit(preparation.source.replace('后文', '后文已改'), withBlock(view));
      expect(result.diagnostics).toEqual([]);
      const nodes = (result.content!.editorState.root as unknown as { children: { type: string; viewId?: string | null }[] }).children;
      expect(nodes.filter(node => node.type === 'database-view')).toEqual([{ type: 'database-view', version: 1, databaseId, viewId: view }]);
    }
  });

  it('treats the same link inside a paragraph as an ordinary link', () => {
    const imported = createContentFromMarkdown(`看这里 [数据库视图](/?page=${databaseId}#nbase-database-view)`);
    expect(JSON.stringify(imported)).not.toContain('"type":"database-view"');
  });
});
