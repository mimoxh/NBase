import { useEffect, useRef, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getTableCellNodeFromLexicalNode } from '@lexical/table';
import { $insertNodeToNearestRoot } from '@lexical/utils';
import { $getSelection, $isParagraphNode, $isRangeSelection, $setSelection, COMMAND_PRIORITY_LOW } from 'lexical';
import type { BaseSelection } from 'lexical';
import { bookmarkLimits, type LinkPreview } from '@nbase/contracts';
import { Modal } from '../../components/Modal';
import { isSafeLinkUrl } from '../markdown';
import { $createBookmarkNode, REQUEST_BOOKMARK_COMMAND } from '../nodes/BookmarkNode';

type Props = { onLinkPreview?: ((url: string) => Promise<LinkPreview>) | undefined; onNotice?: ((message: string) => void) | undefined };

function fallback(url: URL): LinkPreview {
  const host = url.hostname.replace(/^www\./, '');
  return { url: url.toString(), title: host, description: '', siteName: host };
}

/** Bounded, single-line fields, so whatever a page returns still validates. */
function bounded(preview: LinkPreview, url: URL): LinkPreview {
  const line = (value: string, limit: number) => value.replace(/\s+/g, ' ').trim().slice(0, limit);
  return { url: url.toString(), title: line(preview.title, bookmarkLimits.title) || fallback(url).title,
    description: line(preview.description, bookmarkLimits.description), siteName: line(preview.siteName, bookmarkLimits.siteName) };
}

export function BookmarkPlugin({ onLinkPreview, onNotice }: Props) {
  const [editor] = useLexicalComposerContext();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selection = useRef<BaseSelection | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // showModal() focuses the dialog's first control (its close button); typing belongs in the address field.
  useEffect(() => {
    if (!open) return;
    // After the slash command's own update restores the editor caret.
    const timer = window.setTimeout(() => input.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);
  const preview = useRef(onLinkPreview);
  preview.current = onLinkPreview;

  useEffect(() => editor.registerCommand(REQUEST_BOOKMARK_COMMAND, () => {
    const current = $getSelection();
    if ($isRangeSelection(current) && $getTableCellNodeFromLexicalNode(current.anchor.getNode())) {
      onNotice?.('表格内不能插入网页书签。');
      return true;
    }
    selection.current = current?.clone() ?? null;
    setValue(''); setError(''); setOpen(true);
    return true;
  }, COMMAND_PRIORITY_LOW), [editor, onNotice]);

  const submit = async () => {
    let url: URL;
    try { url = new URL(value.trim()); } catch { setError('请输入完整网址，例如 https://example.com'); return; }
    if (!/^https?:$/.test(url.protocol) || !isSafeLinkUrl(url.toString()) || url.toString().length > bookmarkLimits.url) {
      setError('只支持 http 或 https 网址。'); return;
    }
    setBusy(true);
    let card = fallback(url);
    if (preview.current) {
      try { card = bounded(await preview.current(url.toString()), url); }
      catch { onNotice?.('无法读取网页信息，已用网址创建书签。'); }
    }
    setBusy(false); setOpen(false);
    editor.update(() => {
      if (selection.current) $setSelection(selection.current.clone());
      const current = $getSelection();
      const line = $isRangeSelection(current) ? current.anchor.getNode() : null;
      // On an empty line the card goes above it, so the caret line stays below the card.
      if ($isParagraphNode(line) && line.isEmpty()) line.insertBefore($createBookmarkNode(card));
      else $insertNodeToNearestRoot($createBookmarkNode(card));
    });
  };

  if (!open) return null;
  return <Modal title="插入网页书签" onClose={() => { if (!busy) { setOpen(false); editor.focus(); } }}>
    <form className="nbase-bookmark-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label htmlFor="nbase-bookmark-url">网址</label>
      <input ref={input} id="nbase-bookmark-url" value={value} placeholder="https://example.com/article" disabled={busy}
        onChange={event => { setValue(event.target.value); setError(''); }} />
      <p className="nbase-bookmark-hint">{onLinkPreview ? '服务端会读取网页标题和简介，不会加载网页图片。' : '演示模式不读取网页，书签只显示网址。'}</p>
      {error && <p role="alert" className="nbase-bookmark-error">{error}</p>}
      <div className="nbase-bookmark-actions">
        <button type="button" className="nb-btn" disabled={busy} onClick={() => { setOpen(false); editor.focus(); }}>取消</button>
        <button type="submit" className="nb-btn nb-btn-primary" disabled={busy || !value.trim()}>{busy ? '正在读取…' : '插入'}</button>
      </div>
    </form>
  </Modal>;
}
