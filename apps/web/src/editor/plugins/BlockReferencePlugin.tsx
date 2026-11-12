import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { mergeRegister } from '@lexical/utils';
import {
  $getNodeByKey, $getSelection, $isElementNode, $isRangeSelection, COMMAND_PRIORITY_CRITICAL, COMMAND_PRIORITY_LOW, PASTE_COMMAND,
} from 'lexical';
import type { LexicalEditor, NodeKey } from 'lexical';
import { blockReferenceUrl, isBlockId } from '@nbase/contracts';
import { $ensureBlockId, $findBlockById, takeBlockJump } from '../blockAnchors';
import { $createBlockReferenceNode, JUMP_TO_BLOCK_COMMAND } from '../nodes/BlockReferenceNode';

const pasted = /^\[((?:\\.|[^[\]\\\r\n]){1,510})\]\(\/\?page=([0-9a-f-]{36})#block-([a-z0-9]{8})\)$/;

/** Gives the block an anchor if needed and copies a reference to it as a Markdown link. */
export async function copyBlockReference(editor: LexicalEditor, key: NodeKey, documentId: string): Promise<boolean> {
  let reference: string | null = null;
  editor.update(() => {
    const block = $getNodeByKey(key);
    if (!$isElementNode(block)) return;
    const id = $ensureBlockId(block);
    const text = block.getTextContent().replace(/\s+/g, ' ').trim();
    const label = (text.length > 60 ? text.slice(0, 60) + '…' : text) || '块引用';
    reference = `[${label.replace(/[\\[\]]/g, '\\$&')}](${blockReferenceUrl(documentId, id)})`;
  }, { discrete: true });
  if (!reference) return false;
  try { await navigator.clipboard.writeText(reference); return true; } catch { return false; }
}

export function BlockReferencePlugin({ documentId, reveal, onNotice }: {
  documentId: string; reveal: (element: HTMLElement) => void; onNotice?: ((message: string) => void) | undefined;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const jump = (blockId: string) => {
      const key = editor.read('latest', () => $findBlockById(blockId)?.getKey());
      const element = key ? editor.getElementByKey(key) : null;
      if (!element) { onNotice?.('引用的块已不在此页面中。'); return true; }
      reveal(element);
      element.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      element.classList.add('nbase-block-flash');
      window.setTimeout(() => element.classList.remove('nbase-block-flash'), 1600);
      return true;
    };
    const pending = takeBlockJump(documentId);
    // Wait for the first reconciliation of the newly opened page.
    const timer = pending ? window.setTimeout(() => jump(pending), 50) : 0;
    return mergeRegister(
      () => window.clearTimeout(timer),
      editor.registerCommand(JUMP_TO_BLOCK_COMMAND, jump, COMMAND_PRIORITY_LOW),
      editor.registerCommand(PASTE_COMMAND, event => {
        // ClipboardEvent may be undefined (jsdom), and drag-drop paste events carry no clipboard data.
        const text = 'clipboardData' in event ? event.clipboardData?.getData('text/plain').trim() : undefined;
        const match = text ? pasted.exec(text) : null;
        const selection = $getSelection();
        if (!match || !isBlockId(match[3]) || !$isRangeSelection(selection) || !editor.isEditable()) return false;
        event.preventDefault();
        selection.insertNodes([$createBlockReferenceNode(match[2]!, match[3]!, match[1]!.replace(/\\([\\[\]])/g, '$1'))]);
        return true;
      }, COMMAND_PRIORITY_CRITICAL),
    );
  }, [documentId, editor, onNotice, reveal]);
  return null;
}
