import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { mergeRegister } from '@lexical/utils';
import {
  $getSelection, $isElementNode, $isRangeSelection, COMMAND_PRIORITY_EDITOR, COMMAND_PRIORITY_LOW, INSERT_PARAGRAPH_COMMAND, KEY_TAB_COMMAND,
} from 'lexical';
import { $changeIndent } from '../listIndent';
import { $alignable } from '../textFormatting';

/**
 * Tab and Shift+Tab indent lists, paragraphs and headings. Editor priority lets open typeahead
 * menus, code blocks and table navigation answer first; elsewhere Tab keeps moving keyboard focus.
 * A new paragraph split from an indented one keeps its indent, as in word processors.
 */
export function ListIndentPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => mergeRegister(
    editor.registerCommand(KEY_TAB_COMMAND, event => {
      if (editor.isComposing() || event.isComposing || event.keyCode === 229) return false;
      if ($changeIndent(editor, event.shiftKey ? -1 : 1) === 'none') return false;
      event.preventDefault();
      return true;
    }, COMMAND_PRIORITY_EDITOR),
    editor.registerCommand(INSERT_PARAGRAPH_COMMAND, () => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      const indent = $alignable(selection.anchor.getNode())?.getIndent() ?? 0;
      if (!indent) return false;
      const created = selection.insertParagraph();
      if ($isElementNode(created) && $alignable(created) === created) created.setIndent(indent);
      return true;
    }, COMMAND_PRIORITY_LOW),
  ), [editor]);
  return null;
}
