import { useEffect, useState } from 'react';
import type { HistoryState } from '@lexical/history';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $insertNodeToNearestRoot, mergeRegister } from '@lexical/utils';
import {
  $addUpdateTag, $createParagraphNode, $getNodeByKey, $isParagraphNode, $isRootNode,
  COMMAND_PRIORITY_HIGH, HISTORY_PUSH_TAG, type LexicalEditor, type NodeKey,
} from 'lexical';
import { isStoredMermaidSource } from '@nbase/contracts';
import { Modal } from '../../components/Modal';
import { MermaidCopyButton, MermaidPreview } from '../MermaidPreview';
import { defaultMermaidSource } from '../mermaidSource';
import { $createMermaidNode, $isMermaidNode, EDIT_MERMAID_COMMAND, INSERT_MERMAID_COMMAND } from '../nodes/MermaidNode';

function markHistoryChange(editor: LexicalEditor, historyState: HistoryState) {
  historyState.current ??= { editor, editorState: editor.getEditorState() };
  $addUpdateTag(HISTORY_PUSH_TAG);
}

function MermaidSourceDialog({ source, onApply, onClose }: {
  source: string; onApply: (value: string) => void; onClose: () => void;
}) {
  const [value, setValue] = useState(source);
  const [preview, setPreview] = useState(false);
  const valid = isStoredMermaidSource(value);
  return <Modal title="编辑 Mermaid 图表" onClose={onClose} wide>
    <form onSubmit={event => {
      event.preventDefault();
      if (valid) onApply(value);
    }}>
      <label htmlFor="nbase-mermaid-source" className="field-label">图表源码</label>
      <textarea id="nbase-mermaid-source" className="nbase-mermaid-input" autoFocus spellCheck={false} value={value}
        onChange={event => { setValue(event.currentTarget.value); setPreview(false); }} />
      <MermaidPreview source={value} requested={preview} />
      {!valid && <p role="status">源码超出文档大小限制或含无效字符。</p>}
      <div className="dialog-actions">
        <MermaidCopyButton source={value} />
        <button type="button" className="nb-btn" aria-expanded={preview} onClick={() => setPreview(!preview)}>
          {preview ? '关闭预览' : '预览图表'}
        </button>
        <button type="button" className="nb-btn" onClick={onClose}>取消</button>
        <button type="submit" className="nb-btn nb-btn-primary" disabled={!valid}>应用</button>
      </div>
    </form>
  </Modal>;
}

export function MermaidPlugin({ historyState }: { historyState: HistoryState }) {
  const [editor] = useLexicalComposerContext();
  const [target, setTarget] = useState<{ key: NodeKey; source: string } | null>(null);

  useEffect(() => mergeRegister(
    editor.registerCommand(INSERT_MERMAID_COMMAND, parentKey => {
      if (!editor.isEditable()) return false;
      const parent = parentKey === undefined ? null : $getNodeByKey(parentKey);
      if (parentKey !== undefined && (!$isParagraphNode(parent) || !$isRootNode(parent.getParent()))) return false;
      markHistoryChange(editor, historyState);
      const node = $createMermaidNode(defaultMermaidSource);
      if (parent) parent.replace(node);
      else $insertNodeToNearestRoot(node);
      if (!node.getNextSibling()) node.insertAfter($createParagraphNode());
      node.selectNext();
      setTarget({ key: node.getKey(), source: defaultMermaidSource });
      return true;
    }, COMMAND_PRIORITY_HIGH),
    editor.registerCommand(EDIT_MERMAID_COMMAND, key => {
      if (!editor.isEditable()) return false;
      const node = $getNodeByKey(key);
      if (!$isMermaidNode(node)) return false;
      setTarget({ key, source: node.getTextContent() });
      return true;
    }, COMMAND_PRIORITY_HIGH),
  ), [editor, historyState]);

  return target && editor.isEditable() ? <MermaidSourceDialog key={target.key} source={target.source}
    onClose={() => setTarget(null)} onApply={source => {
      editor.update(() => {
        const node = $getNodeByKey(target.key);
        if (!$isMermaidNode(node) || node.getTextContent() === source || !editor.isEditable()) return;
        markHistoryChange(editor, historyState);
        node.setSource(source);
      });
      setTarget(null);
    }} /> : null;
}
