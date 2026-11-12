import { describe, expect, it } from 'vitest';
import { textStyleCss } from '@nbase/contracts';
import { markdownFromContent, parseMarkdownImport } from './markdown';
import { normalizeDocumentContent } from './normalize';
import { parseSourceEdit, prepareSourceEdit } from './sourceEditing';
import type { DocumentContent } from './types';

type Json = Record<string, unknown> & { children?: Json[] };
const rootOf = (content: DocumentContent) => content.editorState.root as unknown as Json;
const flat = (node: Json): Json[] => [node, ...(node.children ?? []).flatMap(flat)];

function roundTrip(source: string) {
  const first = parseMarkdownImport(source);
  expect(first.preservedAsSource, first.warnings.join()).toBe(false);
  const markdown = markdownFromContent(first.content);
  const second = parseMarkdownImport(markdown);
  expect(second.preservedAsSource).toBe(false);
  expect(normalizeDocumentContent(second.content)).toEqual(normalizeDocumentContent(first.content));
  return { content: first.content, markdown };
}

describe('colour, alignment and toggle Markdown subset', () => {
  it('round-trips text and background colours, also across emphasis boundaries', () => {
    const source = '普通 <span style="color:#d44c47">红色 **加粗**</span> 和 **粗<span style="background-color:#fbf3db">底色**之后</span> 结束';
    const { content, markdown } = roundTrip(source);
    const texts = flat(rootOf(content)).filter(node => node.type === 'text');
    expect(texts.filter(node => node.style === textStyleCss({ color: 'red' })).map(node => node.text).join('')).toBe('红色 加粗');
    expect(texts.filter(node => node.style === textStyleCss({ background: 'yellow' })).map(node => node.text).join('')).toBe('底色之后');
    expect(texts.map(node => node.text).join('')).toBe('普通 红色 加粗 和 粗底色之后 结束');
    expect(markdown).toContain('<span style="color:#d44c47">');
    expect(markdown).not.toMatch(/[-]/);
  });

  it('keeps span syntax inside code literal', () => {
    const { content } = roundTrip('行内 `<span style="color:#d44c47">x</span>` 代码\n\n```html\n<span style="color:#d44c47">x</span>\n```');
    expect(flat(rootOf(content)).some(node => typeof node.style === 'string' && node.style !== '')).toBe(false);
  });

  it('round-trips aligned paragraphs and headings', () => {
    const { content, markdown } = roundTrip('<div align="center">\n\n## 居中标题\n\n</div>\n\n<div align="right">\n\n右对齐 **正文**\n\n</div>\n\n普通');
    const blocks = rootOf(content).children!;
    expect(blocks.map(node => [node.type, node.format])).toEqual([['heading', 'center'], ['paragraph', 'right'], ['paragraph', '']]);
    expect(markdown).toContain('<div align="center">\n\n## 居中标题\n\n</div>');
  });

  it('round-trips nested toggles with bodies, also inside a callout', () => {
    const source = '<details>\n<summary>外层 **标题**</summary>\n\n正文一\n\n- 列表\n\n<details>\n<summary>内层</summary>\n\n内层正文\n\n</details>\n\n</details>\n\n> [!NOTE]\n> <details>\n> <summary>提示内</summary>\n>\n> 内容\n>\n> </details>';
    const { content } = roundTrip(source);
    const [outer, callout] = rootOf(content).children!;
    expect(outer!.type).toBe('toggle');
    expect(outer!.children!.map(node => node.type)).toEqual(['paragraph', 'paragraph', 'list', 'toggle']);
    expect(callout!.children![0]!.type).toBe('toggle');
  });

  it('keeps other HTML and malformed subset markup as source', () => {
    for (const source of ['<span style="color:#123456">未知颜色</span>', '<details>\n没有摘要\n</details>', '<div align="center">\n\n未闭合',
      '<span style="color:#d44c47">未闭合', '含保留字符 ']) {
      expect(parseMarkdownImport(source).preservedAsSource, source).toBe(true);
    }
  });

  it('lets the source editor apply documents that use the subset', () => {
    const original = parseMarkdownImport('<details>\n<summary>折叠</summary>\n\n<span style="color:#337ea9">蓝色</span>\n\n</details>\n\n<div align="center">\n\n居中\n\n</div>').content;
    const prepared = prepareSourceEdit(original);
    expect(prepared.diagnostics).toEqual([]);
    expect(prepared.canApply).toBe(true);
    const edited = parseSourceEdit(prepared.source.replace('<span style="color:#337ea9">蓝色</span>', '改成<span style="color:#448361">绿色</span>'), original);
    expect(edited.diagnostics).toEqual([]);
    expect(flat(rootOf(edited.content!)).some(node => node.style === textStyleCss({ color: 'green' }))).toBe(true);
  });
});
