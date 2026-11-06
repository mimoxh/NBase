import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { LexicalTypeaheadMenuPlugin, MenuOption, type MenuRenderFn, type MenuTextMatch } from '@lexical/react/LexicalTypeaheadMenuPlugin';
import type { HistoryState } from '@lexical/history';
import { $isCodeNode } from '@lexical/code';
import { $isLinkNode } from '@lexical/link';
import {
  $addUpdateTag, $findMatchingParent, $getNodeByKey, $getSelection, $isRangeSelection, $isTextNode,
  COMMAND_PRIORITY_CRITICAL, COMMAND_PRIORITY_HIGH, HISTORIC_TAG, HISTORY_PUSH_TAG, KEY_ENTER_COMMAND, KEY_TAB_COMMAND,
  type LexicalEditor, type NodeKey, type TextNode,
} from 'lexical';
import { mergeRegister } from '@lexical/utils';
import { pageReferenceLabelLimit } from '@nbase/contracts';
import { Modal } from '../../components/Modal';
import { $applyLegacyPageReferences, $scanLegacyPageReferences } from '../legacyPageReferences';
import { normalizeDocumentContent } from '../normalize';
import {
  $createPageReferenceNode, $isPageReferenceNode, EDIT_PAGE_REFERENCE_COMMAND, isPageReferenceLabel, usePageReferences,
} from '../nodes/PageReferenceNode';
import { searchPageReferences, type PageReferenceCandidate } from '../pageReferenceCatalog';
import '../pageReferences.css';

const trigger = /(?<!(?<!\\)(?:\\\\)*\\)\[\[([^[\]\r\n]{0,255})$/u;
const legacyConversionTag = 'nbase-legacy-page-references';

export function pageReferenceTrigger(text: string, editor: LexicalEditor): MenuTextMatch | null {
  if (!editor.isEditable() || editor.isComposing()) return null;
  const match = trigger.exec(text);
  if (!match) return null;
  const allowed = editor.read('latest', () => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
    const node = selection.anchor.getNode();
    return $isTextNode(node) && !node.hasFormat('code')
      && !$findMatchingParent(node, ancestor => $isCodeNode(ancestor) || $isLinkNode(ancestor));
  });
  return allowed ? { leadOffset: match.index, matchingString: match[1]!, replaceableString: match[0] } : null;
}

class ReferenceOption extends MenuOption {
  constructor(readonly candidate: PageReferenceCandidate) {
    super(candidate.id);
    this.title = candidate.title;
  }
}

const renderMenu: MenuRenderFn<ReferenceOption> = (anchor, props) => anchor.current && props.options.length ? createPortal(
  <ul className="nbase-slash-menu nbase-reference-menu" role="listbox" aria-label="引用页面">
    {props.options.map((option, index) => <li key={option.key} id={'typeahead-item-' + index} ref={option.setRefElement.bind(option)}
      role="option" aria-selected={index === props.selectedIndex} className={index === props.selectedIndex ? 'is-selected' : ''}
      onMouseDown={event => event.preventDefault()} onMouseEnter={() => props.setHighlightedIndex(index)}
      onClick={() => props.selectOptionAndCleanUp(option)}>
      <span>{option.candidate.title}</span><small>{option.candidate.parentPath}</small>
    </li>)}
  </ul>, anchor.current,
) : null;

function ReferenceLabelDialog({ label, onApply, onClose }: { label: string; onApply: (label: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(label);
  const composing = useRef(false);
  return <Modal title="编辑页面引用文字" onClose={onClose}>
    <form onSubmit={event => {
      event.preventDefault();
      const next = value.trim();
      if (!composing.current && isPageReferenceLabel(next)) onApply(next);
    }}>
      <label htmlFor="nbase-reference-label" className="field-label">显示文字</label>
      <input type="text" id="nbase-reference-label" value={value} maxLength={pageReferenceLabelLimit}
        onChange={event => setValue(event.currentTarget.value)} onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }} />
      <div className="dialog-actions">
        <button type="button" className="nb-btn" onClick={onClose}>取消</button>
        <button type="submit" className="nb-btn nb-btn-primary" disabled={!isPageReferenceLabel(value.trim())}>应用</button>
      </div>
    </form>
  </Modal>;
}

interface LegacyPreview { available: number; unresolved: Array<{ label: string; reason: 'missing' | 'ambiguous' }> }

function countSerializedNodes(node: unknown): number {
  if (!node || typeof node !== 'object' || !('children' in node) || !Array.isArray(node.children)) return 1;
  return node.children.reduce((count, child) => count + countSerializedNodes(child), 1);
}

export function PageReferencePlugin({ historyState }: { historyState: HistoryState }) {
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const catalog = usePageReferences()?.catalog;
  const [query, setQuery] = useState<string | null>(null);
  const [target, setTarget] = useState<{ key: NodeKey; label: string } | null>(null);
  const [legacy, setLegacy] = useState<LegacyPreview | null>(null);
  const [legacyError, setLegacyError] = useState('');
  const options = useMemo(() => catalog && query !== null
    ? searchPageReferences(catalog, query).map(candidate => new ReferenceOption(candidate)) : [], [catalog, query]);
  const pickerActive = useRef(false);
  pickerActive.current = options.length > 0;

  useEffect(() => {
    if (!catalog) return;
    const composing = (event: KeyboardEvent | null) => pickerActive.current
      && (editor.isComposing() || event?.isComposing === true || event?.keyCode === 229);
    return mergeRegister(
      editor.registerCommand(KEY_ENTER_COMMAND, composing, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_TAB_COMMAND, composing, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(EDIT_PAGE_REFERENCE_COMMAND, key => {
        if (!editor.isEditable()) return false;
        const node = $getNodeByKey(key);
        if (!$isPageReferenceNode(node)) return false;
        setTarget({ key, label: node.getTextContent() });
        return true;
      }, COMMAND_PRIORITY_HIGH),
    );
  }, [catalog, editor]);

  useEffect(() => {
    if (!catalog || !editable) { setLegacy(null); return; }
    const scan = (state = editor.getEditorState()) => {
      const report = state.read(() => $scanLegacyPageReferences(catalog));
      setLegacy({ available: report.convertible.length, unresolved: report.unresolved });
    };
    scan();
    return editor.registerUpdateListener(({ editorState, tags }) => {
      if (tags.has(HISTORIC_TAG) || tags.has(legacyConversionTag)) scan(editorState);
    });
  }, [catalog, editor, editable]);

  const select = useCallback((option: ReferenceOption, triggerNode: TextNode | null, close: () => void) => {
    if (!triggerNode || !editor.isEditable() || editor.isComposing() || !catalog?.activeIds.has(option.key)) { close(); return; }
    const title = option.candidate.title;
    const sanitized = title.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/gu, ' ').trim();
    const label = isPageReferenceLabel(sanitized) ? sanitized : '未命名页面';
    historyState.current ??= { editor, editorState: editor.getEditorState() };
    $addUpdateTag(HISTORY_PUSH_TAG);
    triggerNode.replace($createPageReferenceNode(option.key, label)).selectNext();
    close();
  }, [catalog, editor, historyState]);

  function applyLegacy() {
    if (!catalog || !editor.isEditable()) return;
    const snapshot = normalizeDocumentContent({
      schemaVersion: 1, editorState: editor.getEditorState().toJSON(),
    });
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).length;
    const nodeCount = countSerializedNodes(snapshot.editorState.root);
    editor.update(() => {
      const { convertible, unresolved } = $scanLegacyPageReferences(catalog);
      if (!convertible.length) { setLegacy({ available: 0, unresolved }); return; }
      // Each replaced span may add one reference and split a text leaf into two.
      if (bytes + convertible.length * 320 > 1024 * 1024 || nodeCount + convertible.length * 2 > 20_000) {
        setLegacyError('转换后可能超出页面正文大小限制，原文仍保留。');
        return;
      }
      setLegacyError('');
      historyState.current ??= { editor, editorState: editor.getEditorState() };
      $addUpdateTag(HISTORY_PUSH_TAG);
      $addUpdateTag(legacyConversionTag);
      $applyLegacyPageReferences(convertible);
    });
  }

  function applyLabel(label: string) {
    if (!target || !editor.isEditable()) return;
    editor.update(() => {
      const node = $getNodeByKey(target.key);
      if ($isPageReferenceNode(node) && node.getTextContent() !== label) {
        historyState.current ??= { editor, editorState: editor.getEditorState() };
        $addUpdateTag(HISTORY_PUSH_TAG);
        node.setLabel(label);
      }
    });
    setTarget(null);
  }

  return <>
    {catalog && editable && <LexicalTypeaheadMenuPlugin<ReferenceOption>
      options={options} onQueryChange={setQuery} triggerFn={pageReferenceTrigger} onSelectOption={select}
      anchorClassName="nbase-slash-anchor" preselectFirstItem {...(options.length ? { menuRenderFn: renderMenu } : {})} />}
    {catalog && editable && legacy && (legacy.available > 0 || legacy.unresolved.length > 0) && <div className="nbase-legacy-references">
      <p>旧式页面引用 · {legacy.available} 处可以转换，{legacy.unresolved.length} 处将保留原文。</p>
      {legacy.available > 0 && <button type="button" className="nb-btn" onClick={applyLegacy}>转换可唯一解析的引用</button>}
      {legacy.unresolved.length > 0 && <details>
        <summary>查看未解析的引用</summary>
        <ul>{legacy.unresolved.slice(0, 10).map(({ label, reason }, index) => <li key={index}>
          {'[[' + label + ']]'} · {reason === 'ambiguous' ? '存在同名页面' : '没有可访问的目标'}
        </li>)}</ul>
        {legacy.unresolved.length > 10 && <p>另有 {legacy.unresolved.length - 10} 处保留原文。</p>}
      </details>}
      {legacyError && <p role="alert">{legacyError}</p>}
    </div>}
    {target && editable && <ReferenceLabelDialog key={target.key} label={target.label} onApply={applyLabel} onClose={() => setTarget(null)} />}
  </>;
}
