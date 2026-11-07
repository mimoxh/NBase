import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { COMMAND_PRIORITY_EDITOR, KEY_TAB_COMMAND } from 'lexical';
import { $changeListIndent } from '../listIndent';

/**
 * Tab and Shift+Tab inside lists. Editor priority lets open typeahead menus and
 * table navigation answer first; outside a list Tab keeps moving keyboard focus.
 */
export function ListIndentPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.registerCommand(KEY_TAB_COMMAND, event => {
    if (editor.isComposing() || event.isComposing || event.keyCode === 229) return false;
    if ($changeListIndent(editor, event.shiftKey ? -1 : 1) === 'not-list') return false;
    event.preventDefault();
    return true;
  }, COMMAND_PRIORITY_EDITOR), [editor]);
  return null;
}
