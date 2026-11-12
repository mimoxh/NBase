import { describe, expect, it } from 'vitest';
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, createEditor } from 'lexical';
import { EDITOR_NODES } from '../nodes';
import { $applyToggle, $isToggleNode, $normalizeToggle, $unwrapToggle, ToggleNode } from './ToggleNode';

function editorWith(text: string) {
  const editor = createEditor({ namespace: 'toggle-test', nodes: EDITOR_NODES, onError: error => { throw error; } });
  editor.registerNodeTransform(ToggleNode, $normalizeToggle);
  editor.update(() => {
    const paragraph = $createParagraphNode().append($createTextNode(text));
    $getRoot().clear().append(paragraph);
    paragraph.selectEnd();
  }, { discrete: true });
  return editor;
}
const shape = (editor: ReturnType<typeof createEditor>) => editor.getEditorState().read(() =>
  $getRoot().getChildren().map(node => $isToggleNode(node) ? node.getChildren().map(child => child.getTextContent()) : node.getTextContent()));

describe('toggle blocks', () => {
  it('wraps the current paragraph as the summary and keeps new lines inside the body', () => {
    const editor = editorWith('摘要');
    editor.update(() => { $applyToggle(); }, { discrete: true });
    expect(shape(editor)).toEqual([['摘要']]);
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) { selection.insertParagraph(); selection.insertText('正文'); }
    }, { discrete: true });
    expect(shape(editor)).toEqual([['摘要', '正文']]);
  });

  it('restores a paragraph summary and unwraps in order', () => {
    const editor = editorWith('摘要');
    editor.update(() => {
      const toggle = $applyToggle()!;
      toggle.getFirstChild()!.remove();
    }, { discrete: true });
    expect(shape(editor)).toEqual([['']]);
    editor.update(() => { $unwrapToggle($getRoot().getFirstChild() as ToggleNode); }, { discrete: true });
    expect(shape(editor)).toEqual(['']);
  });
});
