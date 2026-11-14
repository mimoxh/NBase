// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { $isListItemNode, $isListNode, type ListItemNode } from '@lexical/list';
import { $getRoot, $isElementNode, INSERT_PARAGRAPH_COMMAND, KEY_TAB_COMMAND, UNDO_COMMAND, type ElementNode, type LexicalEditor, type LexicalNode } from 'lexical';
import { createContentFromMarkdown, markdownFromContent, readEditorSnapshot } from '../markdown';
import { EDITOR_NODES } from '../nodes';
import { prepareSourceEdit } from '../sourceEditing';
import { $applyBlockStyle } from '../blockStyles';
import { listTheme } from '../listTheme';
import { ListIndentPlugin } from './ListIndentPlugin';

let host: HTMLDivElement;
let root: Root;
let editor!: LexicalEditor;

function Capture() {
  [editor] = useLexicalComposerContext();
  return null;
}

async function mount(markdown: string) {
  const initial = createContentFromMarkdown(markdown);
  await act(() => root.render(<LexicalComposer initialConfig={{
    namespace: 'list-indent-test', nodes: EDITOR_NODES, theme: { list: listTheme }, editorState: JSON.stringify(initial.editorState),
    onError: error => { throw error; },
  }}>
    <RichTextPlugin contentEditable={<ContentEditable />} ErrorBoundary={LexicalErrorBoundary} />
    <HistoryPlugin /><ListPlugin /><ListIndentPlugin /><Capture />
  </LexicalComposer>));
}

function $items(node: LexicalNode = $getRoot()): ListItemNode[] {
  if (!$isElementNode(node)) return [];
  const own = $isListItemNode(node) && !node.getChildren().some($isListNode) ? [node] : [];
  return [...own, ...node.getChildren().flatMap(child => $items(child))];
}

async function caretIn(text: string) {
  await act(() => editor.update(() => {
    const item = $items().find(candidate => candidate.getTextContent() === text);
    if (!item) throw new Error('missing item ' + text);
    item.selectEnd();
  }, { discrete: true }));
}

async function press(shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true });
  await act(() => { editor.dispatchCommand(KEY_TAB_COMMAND, event); });
  return event;
}

const depths = () => editor.read('latest', () => Object.fromEntries($items().map(item => [item.getTextContent(), item.getIndent()])));
const markdown = () => readEditorSnapshot(editor.getEditorState()).markdown;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('nests with Tab, un-nests with Shift+Tab and undoes each step at once', async () => {
  await mount('- 一\n- 二\n- 三');
  await caretIn('二');
  expect((await press()).defaultPrevented).toBe(true);
  expect(depths()).toEqual({ 一: 0, 二: 1, 三: 0 });
  await press(true);
  expect(depths()).toEqual({ 一: 0, 二: 0, 三: 0 });
  await press();
  await act(() => { editor.dispatchCommand(UNDO_COMMAND, undefined); });
  expect(depths()).toEqual({ 一: 0, 二: 0, 三: 0 });
});

it('keeps mixed ordered, bullet and task nesting through Markdown and source editing', async () => {
  await mount('1. 一\n2. 二\n\n- [ ] 待办\n- [x] 完成');
  await caretIn('二');
  await press();
  await caretIn('完成');
  await press();
  const content = readEditorSnapshot(editor.getEditorState()).content;
  const exported = markdownFromContent(content);
  expect(exported).toMatch(/1\. 一\n\s+1\. 二/);
  expect(exported).toMatch(/- \[ \] 待办\n\s+- \[x\] 完成/);
  expect(markdownFromContent(createContentFromMarkdown(exported))).toBe(exported);
  expect(prepareSourceEdit(content).canApply).toBe(true);
});

it('refuses to nest the first item of a level or past the depth limit, without losing keyboard handling', async () => {
  await mount('- 一\n- 二\n- 三\n- 四\n- 五\n- 六\n- 七\n- 八');
  await caretIn('一');
  expect((await press()).defaultPrevented).toBe(true);
  expect(depths()['一']).toBe(0);
  await press(true);
  expect(depths()['一']).toBe(0);
  expect(markdown()).toContain('- 一');

  const texts = ['二', '三', '四', '五', '六', '七'];
  for (const [index, text] of texts.entries()) {
    await caretIn(text);
    for (let step = 0; step <= index; step += 1) await press();
  }
  expect(depths()['六']).toBe(5);
  expect(depths()['七']).toBe(5);
});

it('indents every item in a multi-item selection', async () => {
  await mount('- 一\n- 二\n- 三');
  await act(() => editor.update(() => {
    const [, second, third] = $items();
    const selection = second!.select(0, 0);
    selection.focus.set(third!.getFirstDescendant()!.getKey(), 1, 'text');
  }, { discrete: true }));
  await press();
  expect(depths()).toEqual({ 一: 0, 二: 1, 三: 1 });
});

it('cycles bullet and number markers by nesting depth as items are indented and outdented', async () => {
  await mount('- 一\n- 二\n- 三\n- 四\n\n1. 甲\n2. 乙\n3. 丙');
  for (const [text, steps] of [['二', 1], ['三', 2], ['四', 3], ['乙', 1], ['丙', 2]] as const) {
    await caretIn(text);
    for (let step = 0; step < steps; step += 1) await press();
  }
  const marker = (text: string) => {
    const item = [...host.querySelectorAll('li:not(.nbase-list-nested)')].find(li => li.textContent === text);
    return [...item!.parentElement!.classList].find(name => /^nbase-(ul|ol)-/.test(name));
  };
  expect(['一', '二', '三', '四', '甲', '乙', '丙'].map(marker))
    .toEqual(['nbase-ul-disc', 'nbase-ul-circle', 'nbase-ul-square', 'nbase-ul-disc', 'nbase-ol-decimal', 'nbase-ol-alpha', 'nbase-ol-roman']);
  await caretIn('四');
  await press(true);
  await press(true);
  expect(depths()['四']).toBe(1);
  expect(marker('四')).toBe('nbase-ul-circle');
  await caretIn('丙');
  await press(true);
  expect(depths()['丙']).toBe(1);
  expect(marker('丙')).toBe('nbase-ol-alpha');
});

const blockIndents = () => editor.read('latest', () => $getRoot().getChildren().map(block => [block.getTextContent(), $isElementNode(block) ? block.getIndent() : null]));

it('indents paragraphs and headings up to the limit and keeps them through Markdown and source editing', async () => {
  await mount('## 标题\n\n第一段\n\n第二段');
  const caretInBlock = (index: number) => act(() => editor.update(() => { $getRoot().getChildAtIndex(index)!.selectEnd(); }, { discrete: true }));
  await caretInBlock(1);
  expect((await press()).defaultPrevented).toBe(true);
  await caretInBlock(1);
  await press();
  expect(blockIndents()).toEqual([['标题', 0], ['第一段', 2], ['第二段', 0]]);
  await act(() => { editor.dispatchCommand(UNDO_COMMAND, undefined); });
  expect(blockIndents()[1]).toEqual(['第一段', 1]);
  await caretInBlock(1);
  await press(true);
  expect(blockIndents()[1]).toEqual(['第一段', 0]);
  // Shift+Tab at the left edge stays in the editor and changes nothing.
  await caretInBlock(1);
  expect((await press(true)).defaultPrevented).toBe(true);
  expect(blockIndents()[1]).toEqual(['第一段', 0]);

  await act(() => editor.update(() => {
    const selection = $getRoot().getFirstChild()!.selectStart();
    selection.focus.set($getRoot().getLastChildOrThrow<ElementNode>().getFirstDescendant()!.getKey(), 1, 'text');
  }, { discrete: true }));
  for (let step = 0; step < 7; step += 1) {
    await act(() => editor.update(() => {
      const selection = $getRoot().getFirstChild()!.selectStart();
      selection.focus.set($getRoot().getLastChildOrThrow<ElementNode>().getFirstDescendant()!.getKey(), 1, 'text');
    }, { discrete: true }));
    await press();
  }
  expect(blockIndents()).toEqual([['标题', 5], ['第一段', 5], ['第二段', 5]]);

  const content = readEditorSnapshot(editor.getEditorState()).content;
  const exported = markdownFromContent(content);
  expect(exported).toContain('<div style="margin-left:10em">\n\n## 标题\n\n</div>');
  expect(markdownFromContent(createContentFromMarkdown(exported))).toBe(exported);
  expect(prepareSourceEdit(content).canApply).toBe(true);
});

it('keeps the indent on a paragraph split off with Enter', async () => {
  await mount('第一段');
  await act(() => editor.update(() => { $getRoot().getFirstChildOrThrow<ElementNode>().setIndent(2).selectEnd(); }, { discrete: true }));
  await act(() => { editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined); });
  expect(blockIndents()).toEqual([['第一段', 2], ['', 2]]);
});

it('drops indent and alignment when a paragraph becomes a quote or code block', async () => {
  await mount('第一段\n\n第二段');
  for (const [index, style] of [[0, 'quote'], [1, 'code']] as const) {
    await act(() => editor.update(() => {
      $getRoot().getChildAtIndex<ElementNode>(index)!.setIndent(2).setFormat('center').selectEnd();
      $applyBlockStyle(editor, style);
    }, { discrete: true }));
  }
  expect(editor.read('latest', () => $getRoot().getChildren<ElementNode>().map(block => [block.getType(), block.getIndent(), block.getFormatType()])))
    .toEqual([['quote', 0, ''], ['code', 0, '']]);
  expect(prepareSourceEdit(readEditorSnapshot(editor.getEditorState()).content).canApply).toBe(true);
});

it('leaves Tab to the browser where nothing can be indented', async () => {
  await mount('> 引用文字');
  await act(() => editor.update(() => { $getRoot().getFirstChild()!.selectEnd(); }, { discrete: true }));
  expect((await press()).defaultPrevented).toBe(false);
});
