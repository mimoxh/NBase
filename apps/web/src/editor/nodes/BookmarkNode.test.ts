import { describe, expect, it } from 'vitest';
import { markdownFromContent, parseMarkdownImport } from '../markdown';
import { normalizeDocumentContent } from '../normalize';
import { prepareSourceEdit } from '../sourceEditing';
import type { DocumentContent } from '../types';

const bookmark = { type: 'bookmark', version: 1, url: 'https://example.com/a_b?x=(1)', title: '标题 *带* [符号]',
  description: '简介 -- 含 "引号" 与 <尖括号>', siteName: 'Example 站' };
const content = { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, direction: null, format: '', indent: 0,
  children: [bookmark, { type: 'paragraph', version: 1, direction: null, format: '', indent: 0, textFormat: 0, textStyle: '', children: [] }] } } } as unknown as DocumentContent;

describe('web bookmark cards', () => {
  it('round-trips through Markdown with every field intact', () => {
    const markdown = markdownFromContent(content);
    expect(markdown).toMatch(/^<!-- nbase-bookmark site="[^"\s]+" description="[^"\s]+" -->\n\[/);
    const imported = parseMarkdownImport(markdown);
    expect(imported.preservedAsSource, imported.warnings.join()).toBe(false);
    const root = imported.content.editorState.root as unknown as { children: Record<string, unknown>[] };
    expect(root.children[0]).toMatchObject(bookmark);
    expect(normalizeDocumentContent(parseMarkdownImport(markdownFromContent(imported.content)).content))
      .toEqual(normalizeDocumentContent(imported.content));
    expect(prepareSourceEdit(content).canApply).toBe(true);
  });

  it('keeps the source when the comment is not followed by a single web link', () => {
    expect(parseMarkdownImport('<!-- nbase-bookmark site="a" description="b" -->\n\n普通文字').preservedAsSource).toBe(true);
    expect(parseMarkdownImport('<!-- nbase-bookmark site="a" description="b" -->\n\n[x](mailto:a@b.c)').preservedAsSource).toBe(true);
  });
});
