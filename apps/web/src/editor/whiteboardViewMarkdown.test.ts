import { describe, expect, it } from 'vitest';
import { createContentFromMarkdown, markdownFromContent } from './markdown';
import { filterSlashCommands } from './plugins/SlashCommandPlugin';
import { parseSourceEdit, prepareSourceEdit } from './sourceEditing';
import type { DocumentContent } from './types';

const pageId = '0b6f2c1e-5d3a-4e7b-9a10-1c2d3e4f5a77';
const text = (value: string) => ({ type: 'paragraph', version: 1, format: '', indent: 0, direction: null, textFormat: 0, textStyle: '', children: [
  { type: 'text', version: 1, text: value, format: 0, detail: 0, mode: 'normal', style: '' }] });

function withBlock(height?: number): DocumentContent {
  return { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, format: '', indent: 0, direction: null, children: [
    text('前文'), { type: 'whiteboard-view', version: 1, pageId, ...(height ? { height } : {}) }, text('后文'),
  ] } } } as unknown as DocumentContent;
}
const blocks = (content: DocumentContent) => (content.editorState.root as unknown as { children: { type: string }[] }).children
  .filter(node => node.type === 'whiteboard-view');

describe('whiteboard blocks in Markdown', () => {
  it('exports a link line and imports it back as a block, with and without a height', () => {
    expect(markdownFromContent(withBlock())).toContain(`[白板](/?page=${pageId}#nbase-whiteboard-view)`);
    expect(blocks(createContentFromMarkdown(markdownFromContent(withBlock())))).toEqual([{ type: 'whiteboard-view', version: 1, pageId }]);
    const sized = markdownFromContent(withBlock(600));
    expect(sized).toContain(`#nbase-whiteboard-view=600)`);
    expect(blocks(createContentFromMarkdown(sized))).toEqual([{ type: 'whiteboard-view', version: 1, pageId, height: 600 }]);
  });

  it('keeps the block through protected source editing', () => {
    for (const height of [undefined, 600]) {
      const preparation = prepareSourceEdit(withBlock(height));
      expect(preparation.diagnostics).toEqual([]);
      expect(preparation.canApply).toBe(true);
      const result = parseSourceEdit(preparation.source.replace('后文', '后文已改'), withBlock(height));
      expect(result.diagnostics).toEqual([]);
      expect(blocks(result.content!)).toEqual([{ type: 'whiteboard-view', version: 1, pageId, ...(height ? { height } : {}) }]);
    }
  });

  it('leaves an out-of-range height and an inline link as ordinary links', () => {
    expect(JSON.stringify(createContentFromMarkdown(`[白板](/?page=${pageId}#nbase-whiteboard-view=9999)`))).not.toContain('"type":"whiteboard-view"');
    expect(JSON.stringify(createContentFromMarkdown(`看这里 [白板](/?page=${pageId}#nbase-whiteboard-view)`))).not.toContain('"type":"whiteboard-view"');
  });
});

describe('whiteboard slash commands', () => {
  const keys = (whiteboards: 'none' | 'link' | 'all', inTable = false) =>
    filterSlashCommands('baiban', inTable, false, false, whiteboards).map(command => command.key);
  it('appear only where the host can show whiteboards, and creation only where it can create them', () => {
    expect(keys('none')).toEqual([]);
    expect(keys('link')).toEqual(['whiteboard-link']);
    expect(keys('all')).toEqual(['whiteboard', 'whiteboard-link']);
    expect(keys('all', true)).toEqual([]);
  });
});
