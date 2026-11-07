// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { registerHistory, createEmptyHistoryState } from '@lexical/history';
import { registerList } from '@lexical/list';
import { registerRichText } from '@lexical/rich-text';
import { quickCaptureMarker } from '@nbase/contracts';
import { $getRoot, UNDO_COMMAND, createEditor, type LexicalEditor, type LexicalNode } from 'lexical';
import {
  $canConvertBlock, $canDuplicateBlock, $deleteBlock, $duplicateBlock, $moveBlockBy, $moveBlockTo, $selectWholeBlock, $topLevelBlock,
} from './blockActions';
import { $applyBlockStyle } from './blockStyles';
import { createContentFromMarkdown, markdownFromContent, readEditorSnapshot } from './markdown';
import { EDITOR_NODES } from './nodes';

function editorFor(markdown: string): LexicalEditor {
  const editor = createEditor({ nodes: EDITOR_NODES, onError: error => { throw error; } });
  editor.setRootElement(document.createElement('div'));
  registerRichText(editor);
  registerList(editor);
  registerHistory(editor, createEmptyHistoryState(), 0);
  editor.setEditorState(editor.parseEditorState(createContentFromMarkdown(markdown).editorState as never));
  return editor;
}

const change = (editor: LexicalEditor, action: () => void) => editor.update(action, { discrete: true });
const child = (index: number): LexicalNode => $getRoot().getChildAtIndex(index)!;
const markdownOf = (editor: LexicalEditor) => readEditorSnapshot(editor.getEditorState()).markdown;

describe('moving blocks', () => {
  it('moves by a step, to a target, and reports moves that change nothing', () => {
    const editor = editorFor('一\n\n二\n\n三');
    change(editor, () => { expect($moveBlockBy(child(0), -1)).toBe(false); });
    change(editor, () => { expect($moveBlockBy(child(0), 1)).toBe(true); });
    expect(markdownOf(editor)).toBe('二\n\n一\n\n三');
    change(editor, () => { expect($moveBlockTo(child(0), child(2), 'after')).toBe(true); });
    expect(markdownOf(editor)).toBe('一\n\n三\n\n二');
    change(editor, () => { expect($moveBlockTo(child(0), child(1), 'before')).toBe(false); });
    expect(markdownOf(editor)).toBe('一\n\n三\n\n二');
  });

  it('steps over folded siblings as one move and undoes in one step', () => {
    const editor = editorFor('一\n\n隐藏\n\n三');
    change(editor, () => { $moveBlockBy(child(0), 1, node => node.getTextContent() !== '隐藏'); });
    expect(markdownOf(editor)).toBe('隐藏\n\n三\n\n一');
    change(editor, () => { editor.dispatchCommand(UNDO_COMMAND, undefined); });
    expect(markdownOf(editor)).toBe('一\n\n隐藏\n\n三');
  });

  it('finds the top-level block of a nested node', () => {
    const editor = editorFor('- 项\n  - 子项');
    editor.read('latest', () => {
      const text = $getRoot().getLastDescendant()!;
      expect($topLevelBlock(text)?.is(child(0))).toBe(true);
    });
  });
});

describe('copying and deleting blocks', () => {
  it('copies a table, list or formatted paragraph after the source', () => {
    const editor = editorFor('**粗体** ==高亮==\n\n| 甲 |\n| --- |\n| 乙 |\n\n- 一\n  - 二');
    change(editor, () => { $duplicateBlock(child(2)); });
    change(editor, () => { $duplicateBlock(child(1)); });
    change(editor, () => { $duplicateBlock(child(0)); });
    const value = markdownOf(editor);
    expect(value.split('**粗体** ==高亮==').length).toBe(3);
    expect(value.split('| 乙 |').length).toBe(3);
    expect(value.match(/- 一\n\s+- 二/g)).toHaveLength(2);
  });

  it('never copies a footnote definition or a quick-capture marker', () => {
    const editor = editorFor('正文[^a]\n\n[^a]: 定义');
    editor.read('latest', () => {
      expect($canDuplicateBlock(child(0))).toBe(true);
      expect($canDuplicateBlock(child(1))).toBe(false);
    });
    change(editor, () => { expect($duplicateBlock(child(1))).toBeNull(); });
    expect(markdownOf(editor).split('[^a]:').length).toBe(2);

    const content = createContentFromMarkdown('## 记录');
    const tree = content.editorState as unknown as { root: { children: { $?: Record<string, unknown> }[] } };
    tree.root.children[0]!.$ = { [quickCaptureMarker]: true };
    const marked = createEditor({ nodes: EDITOR_NODES, onError: error => { throw error; } });
    marked.setEditorState(marked.parseEditorState(content.editorState as never));
    change(marked, () => { $duplicateBlock(child(0)); });
    const blocks = (readEditorSnapshot(marked.getEditorState()).content.editorState as unknown as typeof tree).root.children;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.$?.[quickCaptureMarker]).toBe(true);
    expect(blocks[1]!.$?.[quickCaptureMarker]).toBeUndefined();
  });

  it('leaves an empty paragraph after deleting the only block', () => {
    const editor = editorFor('唯一');
    change(editor, () => { $deleteBlock(child(0)); });
    expect(markdownOf(editor)).toBe('');
    editor.read('latest', () => { expect($getRoot().getChildrenSize()).toBe(1); });
  });
});

it('converts every item of a list and keeps text through the conversion', () => {
  const editor = editorFor('- 一\n- 二');
  change(editor, () => {
    expect($canConvertBlock(child(0))).toBe(true);
    $selectWholeBlock(child(0));
    $applyBlockStyle(editor, 'h2');
  });
  expect(markdownFromContent(readEditorSnapshot(editor.getEditorState()).content)).toBe('## 一\n\n## 二');
});
