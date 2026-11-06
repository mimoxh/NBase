import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createParagraphNode, $findMatchingParent, $getSelection, $isParagraphNode, $isRangeSelection,
  COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND,
} from 'lexical';
import { $isCalloutNode } from '../nodes/CalloutNode';

export function CalloutPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.registerCommand(KEY_ENTER_COMMAND, event => {
    if (!event || event.shiftKey || event.isComposing || event.keyCode === 229
      || editor.isComposing() || !editor.isEditable()) return false;
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
    const paragraph = $findMatchingParent(selection.anchor.getNode(), $isParagraphNode);
    if (!paragraph || !paragraph.isEmpty() || paragraph.getNextSibling()) return false;
    const callout = paragraph.getParent();
    if (!$isCalloutNode(callout)) return false;
    event.preventDefault();
    callout.insertAfter($createParagraphNode()).selectStart();
    if (callout.getChildrenSize() > 1) paragraph.remove();
    return true;
  }, COMMAND_PRIORITY_HIGH), [editor]);
  return null;
}
