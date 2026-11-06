// @vitest-environment jsdom
import { expect, it } from 'vitest';
import source from '../../../../docs/fixtures/markdown/notes-mixed.md?raw';
import { addMarkdownFrontMatter, markdownFromContent, parseMarkdownImport } from './markdown';

it('round trips the frozen A–D mixed fixture with its metadata and repeated footnotes', () => {
  const first = parseMarkdownImport(source);
  expect(first.preservedAsSource, first.warnings.join('\n')).toBe(false);
  const exported = addMarkdownFrontMatter(markdownFromContent(first.content), first.content, first.title!, first.tagNames);
  const second = parseMarkdownImport(exported);
  expect(second.preservedAsSource, second.warnings.join('\n')).toBe(false);
  expect(second.title).toBe(first.title);
  expect(second.tagNames).toEqual(first.tagNames);
  expect(second.content).toEqual(first.content);
  expect(JSON.stringify(second.content)).toContain('mermaid');
  expect(JSON.stringify(second.content)).toContain('footnote-reference');
});

it('keeps footnote definition positions when exporting and reimporting body placed after them', () => {
  const first = parseMarkdownImport('前文[^a]\n\n[^a]: **定义**\n\n定义后的正文[^a]');
  expect(first.preservedAsSource).toBe(false);
  expect(first.content.editorState.root.children.map(node => node.type)).toEqual(['paragraph', 'footnote-definition', 'paragraph']);
  const second = parseMarkdownImport(markdownFromContent(first.content));
  expect(second.preservedAsSource).toBe(false);
  expect(second.content).toEqual(first.content);
});
