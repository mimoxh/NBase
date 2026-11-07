import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { $isLinkNode } from '@lexical/link';
import { $findMatchingParent, mergeRegister } from '@lexical/utils';
import {
  $getNearestNodeFromDOMNode, $getNodeByKey, $getSelection, $isRangeSelection, $isTextNode, BLUR_COMMAND,
  COMMAND_PRIORITY_LOW, KEY_ENTER_COMMAND, KEY_ESCAPE_COMMAND, KEY_SPACE_COMMAND,
} from 'lexical';
import type { NodeKey } from 'lexical';
import { $linkUrlBeforeCaret } from '../autoLink';
import { isSafeLinkUrl } from '../markdown';
import './linkCard.css';

type Card = { key: NodeKey; url: string; source: 'hover' | 'caret' };
type Props = { onNotice?: ((message: string) => void) | undefined };

const hoverDelay = 200;
const leaveDelay = 250;

function openLink(url: string): void {
  if (isSafeLinkUrl(url)) window.open(url, '_blank', 'noopener,noreferrer');
}

/** Opens links, shows the link card, and turns a typed URL into a link on space or Enter. */
export function LinkInteractionPlugin({ onNotice }: Props) {
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const [card, setCard] = useState<Card | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const element = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const dismissed = useRef<NodeKey | null>(null);
  const current = useRef({ card, editing });
  current.current = { card, editing };

  const close = useCallback(() => { setCard(null); setEditing(false); setError(''); }, []);
  const schedule = useCallback((action: () => void, delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(action, delay);
  }, []);
  const leave = useCallback(() => schedule(() => {
    if (current.current.card?.source === 'hover' && !current.current.editing) close();
  }, leaveDelay), [close, schedule]);

  useEffect(() => editor.registerRootListener((root, previous) => {
    // Page references share the link style but navigate inside the workspace.
    const anchorOf = (event: Event) => event.target instanceof Element && !event.target.closest('.nbase-page-reference')
      ? event.target.closest<HTMLAnchorElement>('a.nbase-link') : null;
    const onClick = (event: MouseEvent) => {
      const anchor = anchorOf(event);
      if (!anchor) return;
      event.preventDefault();
      // While editing a plain click only places the caret.
      if (!editor.isEditable() || event.ctrlKey || event.metaKey) openLink(anchor.getAttribute('href') ?? '');
    };
    const onOver = (event: MouseEvent) => {
      const anchor = anchorOf(event);
      if (!anchor) return;
      schedule(() => {
        const link = editor.read('latest', () => {
          const node = $getNearestNodeFromDOMNode(anchor);
          const found = node && $findMatchingParent(node, $isLinkNode);
          return found ? { key: found.getKey(), url: found.getURL() } : null;
        });
        if (link && !current.current.editing) setCard({ ...link, source: 'hover' });
      }, hoverDelay);
    };
    const onOut = (event: MouseEvent) => { if (anchorOf(event)) leave(); };
    previous?.removeEventListener('click', onClick);
    previous?.removeEventListener('mouseover', onOver);
    previous?.removeEventListener('mouseout', onOut);
    root?.addEventListener('click', onClick);
    root?.addEventListener('mouseover', onOver);
    root?.addEventListener('mouseout', onOut);
    return () => {
      root?.removeEventListener('click', onClick);
      root?.removeEventListener('mouseover', onOver);
      root?.removeEventListener('mouseout', onOut);
    };
  }), [editor, leave, schedule]);

  useEffect(() => {
    const composing = (event: KeyboardEvent | null) => editor.isComposing()
      || Boolean(event && (event.isComposing || event.keyCode === 229));
    return mergeRegister(
      editor.registerUpdateListener(({ editorState }) => editorState.read(() => {
        const selection = $getSelection();
        const link = $isRangeSelection(selection) && selection.isCollapsed()
          ? $findMatchingParent(selection.anchor.getNode(), $isLinkNode) : null;
        const open = current.current.card;
        if (open && !$isLinkNode($getNodeByKey(open.key))) { close(); return; }
        if (link && editor.isEditable()) {
          if (dismissed.current === link.getKey() || current.current.editing) return;
          dismissed.current = null;
          const next = { key: link.getKey(), url: link.getURL(), source: 'caret' as const };
          setCard(value => value?.key === next.key && value.url === next.url ? value : next);
          return;
        }
        dismissed.current = null;
        if (open?.source === 'caret' && !current.current.editing) close();
      })),
      editor.registerCommand(BLUR_COMMAND, event => {
        const next = event.relatedTarget;
        if (current.current.card?.source === 'caret' && !(next instanceof Node && element.current?.contains(next))) close();
        return false;
      }, COMMAND_PRIORITY_LOW),
      editor.registerCommand(KEY_ESCAPE_COMMAND, () => {
        const open = current.current.card;
        if (!open) return false;
        dismissed.current = open.key;
        close();
        return true;
      }, COMMAND_PRIORITY_LOW),
      editor.registerCommand(KEY_SPACE_COMMAND, event => {
        if (composing(event) || !$linkUrlBeforeCaret()) return false;
        event.preventDefault();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText(' ');
        return true;
      }, COMMAND_PRIORITY_LOW),
      editor.registerCommand(KEY_ENTER_COMMAND, event => {
        if (!composing(event)) $linkUrlBeforeCaret();
        return false;
      }, COMMAND_PRIORITY_LOW),
    );
  }, [close, editor]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (!card) { setPosition(null); return; }
    const place = () => {
      const target = editor.getElementByKey(card.key);
      const box = element.current;
      if (!target || !box) return;
      const rect = target.getBoundingClientRect();
      const below = rect.bottom + 6;
      const fitsBelow = below + box.offsetHeight <= window.innerHeight - 8;
      setPosition({
        top: fitsBelow ? below : Math.max(8, rect.top - box.offsetHeight - 6),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - box.offsetWidth - 8)),
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [card, editing, editor]);

  if (!card) return null;
  const copy = () => {
    void navigator.clipboard.writeText(card.url).then(
      () => onNotice?.('已复制链接。'),
      () => onNotice?.('复制失败，请手动选择链接地址。'));
  };
  const remove = () => {
    editor.update(() => {
      const link = $getNodeByKey(card.key);
      if (!$isLinkNode(link)) return;
      for (const child of link.getChildren()) link.insertBefore(child);
      link.remove();
    });
    close();
    editor.focus();
  };
  const apply = () => {
    const url = draft.trim();
    if (!url || !isSafeLinkUrl(url)) { setError('请输入 http、https、mailto 或安全的相对链接。'); return; }
    editor.update(() => {
      const link = $getNodeByKey(card.key);
      if (!$isLinkNode(link)) return;
      // A link showing its own address keeps showing it after the edit.
      const label = link.getFirstChild();
      if (link.getChildrenSize() === 1 && $isTextNode(label) && label.getTextContent() === link.getURL()) label.setTextContent(url);
      link.setURL(url);
    });
    close();
    editor.focus();
  };
  const cancelEdit = () => { setEditing(false); setError(''); editor.focus(); };
  const action = (label: string, run: () => void, title = label) => <button type="button" title={title}
    onMouseDown={event => event.preventDefault()} onClick={run}>{label}</button>;
  return <div ref={element} className="nbase-link-card" role="group" aria-label="链接操作"
    style={position ?? { visibility: 'hidden', top: 0, left: 0 }}
    onMouseEnter={() => window.clearTimeout(timer.current)} onMouseLeave={leave}>
    {editing
      ? <form onSubmit={event => { event.preventDefault(); apply(); }}>
        <input aria-label="链接地址" autoFocus value={draft} onChange={event => { setDraft(event.target.value); setError(''); }}
          onKeyDown={event => { if (event.key === 'Escape') cancelEdit(); }} />
        <button type="submit">应用</button>
        {action('取消', cancelEdit)}
        {error && <span role="alert">{error}</span>}
      </form>
      : <>
        <span className="nbase-link-card-url" title={card.url}>{card.url}</span>
        {action('打开', () => openLink(card.url), editable ? '打开链接，也可 Ctrl/Cmd+单击' : '打开链接')}
        {action('复制', copy)}
        {editable && action('编辑', () => { setDraft(card.url); setError(''); setEditing(true); })}
        {editable && action('移除', remove)}
      </>}
  </div>;
}
