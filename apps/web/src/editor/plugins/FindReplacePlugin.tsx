import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HistoryState } from '@lexical/history';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $addUpdateTag, $getRoot, COMPOSITION_END_TAG, HISTORIC_TAG, HISTORY_PUSH_TAG, SKIP_DOM_SELECTION_TAG } from 'lexical';
import type { LexicalEditor, RootNode } from 'lexical';
import { $findDocumentMatches, $replaceDocumentMatches, allDocumentMatches, documentMatchAt } from '../findDocument';
import type { DocumentMatch } from '../findDocument';
import { normalizeDocumentContent } from '../normalize';
import './findReplace.css';

interface Props {
  title?: string | undefined;
  onReplaceTitle?: ((title: string, bodyChanged: boolean) => void) | undefined;
  readOnly: boolean;
  reveal?: ((element: HTMLElement) => void) | undefined;
  historyState: HistoryState;
}

interface TitleEdit { previous: TitleEdit | null; before: string; after: string; bodyChanged: boolean }

const replaceTag = 'nbase-page-find-replace';
const highlightName = 'nbase-find-current';

function titleElement(root: HTMLElement): HTMLElement | null {
  return root.closest('.nbase-history-preview, .nb-scroll, dialog')?.querySelector('[data-nbase-find-title]') ?? null;
}

function textPoint(element: HTMLElement, offset: number): [Text, number] | null {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    if (offset <= text.length) return [text, offset];
    offset -= text.length;
  }
  return null;
}

function showMatch(editor: LexicalEditor, match: DocumentMatch, reveal: Props['reveal']): (() => void) | undefined {
  const root = editor.getRootElement();
  if (!root) return;
  const first = match.kind === 'title' ? titleElement(root) : editor.getElementByKey(match.spans[0]!.key);
  const last = match.kind === 'title' ? first : editor.getElementByKey(match.spans.at(-1)!.key);
  if (!first || !last) return;
  reveal?.(first);
  first.scrollIntoView?.({ block: 'center', inline: 'nearest' });

  if (match.replaceable && typeof Highlight === 'function' && CSS.highlights) {
    const start = textPoint(first, match.kind === 'title' ? match.start : match.spans[0]!.start);
    const end = textPoint(last, match.kind === 'title' ? match.end : match.spans.at(-1)!.end);
    if (start && end) {
      const range = first.ownerDocument.createRange();
      range.setStart(...start);
      range.setEnd(...end);
      const highlight = new Highlight(range);
      CSS.highlights.set(highlightName, highlight);
      return () => { if (CSS.highlights.get(highlightName) === highlight) CSS.highlights.delete(highlightName); };
    }
  }

  first.dataset.nbaseFindActive = '';
  if (first instanceof HTMLInputElement && match.kind === 'title') first.setSelectionRange(match.start, match.end);
  return () => { delete first.dataset.nbaseFindActive; };
}

export function FindReplacePlugin(props: Props) {
  const { readOnly, title = '', onReplaceTitle } = props;
  const [editor] = useLexicalComposerContext();
  const callbacks = useRef(props);
  callbacks.current = props;
  const [open, setOpen] = useState(false);
  const [rawQuery, setRawQuery] = useState('');
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [position, setPosition] = useState(0);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState('');
  const composing = useRef(false);
  const visible = useRef(false);
  visible.current = open;
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<Element | null>(null);
  // Keep title changes alongside in-memory editor history, separate from persisted body JSON.
  const titleEdits = useRef<WeakMap<RootNode, TitleEdit> | null>(null);

  useLayoutEffect(() => editor.registerUpdateListener(({ editorState, prevEditorState, tags, dirtyElements, dirtyLeaves }) => {
    const edits = titleEdits.current;
    const bodyDirty = dirtyElements.size > 0 || dirtyLeaves.size > 0;
    if (edits && bodyDirty) {
      const before = edits.get(prevEditorState.read($getRoot)) ?? null;
      const nextRoot = editorState.read($getRoot);
      if (tags.has(replaceTag) || tags.has(HISTORIC_TAG)) {
        const after = edits.get(nextRoot) ?? null;
        const currentTitle = callbacks.current.title ?? '';
        if (before !== after) {
          if (after?.previous === before && after.before === currentTitle) {
            callbacks.current.onReplaceTitle?.(after.after, after.bodyChanged);
          } else if (before?.previous === after && before.after === currentTitle) {
            callbacks.current.onReplaceTitle?.(before.before, before.bodyChanged);
          }
        }
      } else if (before) {
        edits.set(nextRoot, before);
      }
    }
    if (visible.current && !editor.isComposing() && (bodyDirty || tags.has(COMPOSITION_END_TAG))) {
      setRevision(value => value + 1);
    }
  }), [editor]);

  useEffect(() => {
    const document = panel.current?.ownerDocument;
    if (!document) return;
    const keydown = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.shiftKey || event.altKey || event.isComposing || event.key.toLowerCase() !== 'f') return;
      const dialog = Array.from(document.querySelectorAll('dialog[open]')).at(-1) ?? null;
      if (dialog !== (panel.current?.closest('dialog') ?? null)) return;
      event.preventDefault();
      if (visible.current) input.current?.focus({ preventScroll: true });
      else { returnFocus.current = document.activeElement; setOpen(true); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, []);

  useLayoutEffect(() => { if (open) input.current?.focus({ preventScroll: true }); else composing.current = false; }, [open]);

  const index = useMemo(() => editor.read('latest', () => $findDocumentMatches(open ? query : '', { title, caseSensitive })),
    [editor, open, query, title, caseSensitive, revision]);
  const currentPosition = Math.min(position, index.count - 1);
  const match = documentMatchAt(index, currentPosition);
  const currentReplaceable = match?.replaceable && (match.kind === 'body' || Boolean(onReplaceTitle));

  useLayoutEffect(() => {
    const current = documentMatchAt(index, currentPosition);
    return current ? showMatch(editor, current, callbacks.current.reveal) : undefined;
  }, [editor, index, currentPosition]);

  const commitQuery = (value: string) => { setQuery(value); setPosition(0); setStatus(''); };
  const navigate = (direction: number) => {
    if (index.count) setPosition((currentPosition + direction + index.count) % index.count);
    setStatus('');
  };
  const close = () => {
    setOpen(false); setStatus('');
    const previous = returnFocus.current;
    returnFocus.current = null;
    queueMicrotask(() => {
      const target = previous instanceof HTMLElement && previous.isConnected ? previous : editor.getRootElement();
      target?.focus({ preventScroll: true });
    });
  };

  const replace = (all: boolean) => {
    if (readOnly || !editor.isEditable() || !query || editor.isComposing() || composing.current) return;
    const before = normalizeDocumentContent({ schemaVersion: 1, editorState: editor.getEditorState().toJSON() });
    const maxGrowthBytes = Math.max(0, 1024 * 1024 - new TextEncoder().encode(JSON.stringify(before)).length);
    let status = '';
    editor.update(() => {
      const currentTitle = callbacks.current.title ?? '';
      const latest = $findDocumentMatches(query, { title: currentTitle, caseSensitive });
      const selected = documentMatchAt(latest, currentPosition);
      const matches = all ? allDocumentMatches(latest) : selected ? [selected] : [];
      const result = $replaceDocumentMatches(matches, replacement, currentTitle, Boolean(callbacks.current.onReplaceTitle), maxGrowthBytes);
      if (result.titleTooLong) { status = '替换后的标题超过 255 个字符。'; return; }
      if (result.bodyTooLarge) { status = '替换后的正文超过文档大小限制。'; return; }
      if (result.changed) {
        const history = callbacks.current.historyState;
        history.current ??= { editor, editorState: editor.getEditorState() };
        $addUpdateTag(HISTORY_PUSH_TAG);
        $addUpdateTag(SKIP_DOM_SELECTION_TAG);
        if (result.title !== currentTitle) {
          const edits = titleEdits.current ??= new WeakMap();
          const previous = edits.get(editor.getEditorState().read($getRoot)) ?? null;
          $addUpdateTag(replaceTag);
          edits.set($getRoot().getWritable(), { previous, before: currentTitle, after: result.title, bodyChanged: result.bodyChanged });
        }
      }
      status = result.changed ? `已替换 ${result.changed} 处。` : '没有内容需要替换。';
      if (result.skipped) status += ` ${result.skipped} 处命中仅可定位。`;
    }, { discrete: true });
    setStatus(status);
  };

  // Stays mounted while closed: the Ctrl/Cmd+F listener is bound through this element's document.
  return <div ref={panel} className="nbase-page-find" hidden={!open} onKeyDown={event => {
    if (open && event.key === 'Escape' && !event.nativeEvent.isComposing && !composing.current) {
      event.preventDefault(); event.stopPropagation(); close();
    }
  }}>
    {open &&
      <div className="nbase-page-find-panel" role="search" aria-label="页内查找与替换">
        <div className="nbase-page-find-row">
          <input ref={input} aria-label="查找内容" placeholder="查找内容" value={rawQuery} maxLength={1024}
            onChange={event => { const value = event.target.value; setRawQuery(value); if (!composing.current) commitQuery(value); }}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={event => { composing.current = false; setRawQuery(event.currentTarget.value); commitQuery(event.currentTarget.value); }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); navigate(event.shiftKey ? -1 : 1); }
            }} />
          <label><input type="checkbox" checked={caseSensitive} onChange={event => { setCaseSensitive(event.target.checked); setPosition(0); setStatus(''); }} />区分大小写</label>
          <output aria-live="polite" aria-label="查找命中">{query ? `${currentPosition + 1} / ${index.count}` : '输入查找内容'}</output>
          <button type="button" aria-label="上一处命中" disabled={!index.count} onClick={() => navigate(-1)}>↑</button>
          <button type="button" aria-label="下一处命中" disabled={!index.count} onClick={() => navigate(1)}>↓</button>
          <button type="button" onClick={close}>关闭查找</button>
        </div>
        {!readOnly && <div className="nbase-page-find-row">
          <input aria-label="替换为" placeholder="替换为" value={replacement} maxLength={1024} onChange={event => { setReplacement(event.target.value); setStatus(''); }} />
          <button type="button" disabled={!currentReplaceable} onClick={() => replace(false)}>替换当前</button>
          <button type="button" disabled={!index.count} onClick={() => replace(true)}>全部替换</button>
        </div>}
        {match && !currentReplaceable && !readOnly && <small>此命中涉及受保护内容或跨越链接边界，只可定位。</small>}
        {status && <small role="status">{status}</small>}
      </div>}
  </div>;
}
