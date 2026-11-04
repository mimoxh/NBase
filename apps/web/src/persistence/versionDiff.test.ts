import { describe, expect, it } from 'vitest';
import { charSpans, diffVersions, extractBlocks } from './versionDiff';
import type { DocumentContent } from '../editor/types';

const text = (value: string) => ({ type: 'text', version: 1, text: value });
const para = (value: string) => ({ type: 'paragraph', version: 1, children: [text(value)] });
const doc = (...children: unknown[]): DocumentContent => ({
  schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children } } as DocumentContent['editorState'],
});

describe('extractBlocks', () => {
  it('flattens lists, tables and special nodes into text blocks', () => {
    const blocks = extractBlocks(doc(
      para('intro'),
      { type: 'heading', version: 1, tag: 'h2', children: [text('标题')] },
      { type: 'list', version: 1, listType: 'check', children: [
        { type: 'listitem', version: 1, checked: true, children: [text('完成项')] },
        { type: 'listitem', version: 1, checked: false, children: [text('待办')] },
      ] },
      { type: 'table', version: 1, children: [
        { type: 'tablerow', version: 1, children: [
          { type: 'tablecell', version: 1, children: [text('A')] },
          { type: 'tablecell', version: 1, children: [text('B')] },
        ] },
      ] },
      { type: 'code', version: 1, children: [text('ls -la')] },
    ));
    expect(blocks.map(b => b.kind)).toEqual(['paragraph', 'hh2', 'todo', 'todo', 'table', 'code']);
    expect(blocks[2]!).toMatchObject({ checked: true, text: '完成项' });
    expect(blocks[4]!.text).toBe('A | B');
  });
});

describe('charSpans', () => {
  it('marks kept, removed and added characters', () => {
    const spans = charSpans('abcdef', 'abXYdef');
    expect(spans.filter(s => s.tone === 'keep').map(s => s.text).join('')).toBe('abdef');
    expect(spans.filter(s => s.tone === 'del').map(s => s.text).join('')).toBe('c');
    expect(spans.filter(s => s.tone === 'add').map(s => s.text).join('')).toBe('XY');
  });
});

describe('diffVersions', () => {
  it('keeps unchanged blocks and renders a paired paragraph edit inline', () => {
    const oldDoc = doc(para('第一段不变'), para('旧内容需要替换掉'));
    const newDoc = doc(para('第一段不变'), para('新内容需要替换掉吧'));
    const { lines, tooLarge } = diffVersions(oldDoc, newDoc);
    expect(tooLarge).toBe(false);
    expect(lines[0]).toMatchObject({ type: 'keep' });
    const change = lines.find(l => l.type === 'change');
    expect(change && 'spans' in change && change.spans.some(s => s.tone === 'del')).toBe(true);
    expect(lines.every(l => l.type !== 'del')).toBe(true);
  });
  it('emits whole-block add and del for unrelated changes', () => {
    const { lines } = diffVersions(doc(para('alpha')), doc(para('完全不同的内容'), para('alpha')));
    expect(lines.some(l => l.type === 'add')).toBe(true);
    expect(lines.some(l => l.type === 'keep')).toBe(true);
  });
});
