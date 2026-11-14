import { useRef, useState, type ReactNode } from 'react';
import { isWhiteboardContent, whiteboardViewHeight } from '@nbase/contracts';
import { LazyWhiteboard } from '../whiteboard/lazy';
import { boardSnapshot } from '../whiteboard/host';
import { EmbedPathProvider, embedStateLabel, useEmbedBlocked, useEmbeddedPage, useEmbeddedPages, type EmbeddedPages } from './source';
import './embed.css';

/** Shown where the page itself cannot be: a repeated ancestor, too deep, or a host without page access. */
export function EmbedLink({ pageId, embeds, fallbackIcon, note, actions }: {
  pageId: string; embeds: EmbeddedPages | null; fallbackIcon: string; note: string; actions?: ReactNode;
}) {
  const info = embeds?.pages.find(page => page.id === pageId);
  return <div className="nb-embed-link">
    <button type="button" className="nb-embed-title" disabled={!embeds} onClick={() => embeds?.openPage(pageId)}>
      <span aria-hidden="true">{info?.icon ?? fallbackIcon}</span>{info ? info.title || '未命名' : '页面'}</button>
    <span className="nb-embed-note">{note}</span>{actions}
  </div>;
}

function LiveBoard({ pageId, embeds, editable, height, onHeight, actions }: {
  pageId: string; embeds: EmbeddedPages; editable: boolean; height: number;
  onHeight?: ((height: number) => void) | undefined; actions?: ReactNode;
}) {
  const view = useEmbeddedPage(pageId, editable);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  const titleRef = useRef('');
  titleRef.current = view.page?.title ?? '';
  const info = embeds.pages.find(page => page.id === pageId);
  const title = info?.title ?? view.page?.title ?? '';
  const content = view.page && isWhiteboardContent(view.page.content) ? view.page.content : null;
  const shown = dragHeight ?? height;
  const clamp = (value: number) => Math.round(Math.min(whiteboardViewHeight.max, Math.max(whiteboardViewHeight.min, value)));

  return <div className="nb-embed nb-embed-board">
    <div className="nb-embed-head">
      <button type="button" className="nb-embed-title" title="打开白板" onClick={() => embeds.openPage(pageId)}>
        <span aria-hidden="true">{info?.icon ?? view.page?.icon ?? '🎨'}</span>{title || '未命名白板'} ↗</button>
      <span className={`nb-embed-state nb-embed-state-${view.saveState}`} role="status">{embedStateLabel[view.saveState]}</span>
      {view.status === 'ready' && content && editable && embeds.canWrite && !view.writable && view.saveState !== 'conflict'
        && <span className="nb-embed-note">此白板已在本页另一处打开，这里只读</span>}
      <span className="nb-embed-spacer" />{actions}
    </div>
    <div className="nb-embed-body" style={{ height: shown }}>
      {view.status === 'loading' ? <div className="nb-embed-message" role="status">正在读取白板…</div>
        : view.status === 'error' ? <div className="nb-embed-message" role="alert">白板读取失败。
          <button type="button" className="nb-btn nb-btn-quiet" onClick={view.reload}>重试</button></div>
        : !view.page ? <div className="nb-embed-message">白板不存在或已删除。</div>
        : !content ? <div className="nb-embed-message">这个页面不是白板。</div>
        : <EmbedPathProvider pageId={pageId}>
          <LazyWhiteboard key={`${pageId}:${view.epoch}`} boardId={pageId} content={content} readOnly={!view.writable} embedded
            title={title} pages={embeds.pages} onNotice={embeds.notice} onOpenPage={embeds.openPage}
            imageUrl={embeds.imageUrl} onUploadImages={view.writable ? embeds.uploadImages : undefined}
            onChange={(id, next) => embeds.save(id, titleRef.current, boardSnapshot(next))} />
        </EmbedPathProvider>}
    </div>
    {onHeight && <div className="nb-embed-resize" role="separator" aria-orientation="horizontal" aria-label="调整白板高度" title="拖动调整高度"
      onPointerDown={event => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startY: event.clientY, startHeight: shown };
      }}
      onPointerMove={event => { if (drag.current) setDragHeight(clamp(drag.current.startHeight + event.clientY - drag.current.startY)); }}
      onPointerUp={() => {
        if (!drag.current) return;
        drag.current = null;
        if (dragHeight !== null && dragHeight !== height) onHeight(dragHeight);
        setDragHeight(null);
      }}
      onPointerCancel={() => { drag.current = null; setDragHeight(null); }} />}
  </div>;
}

/** A whiteboard page shown inside another page. Edits are saved to the whiteboard, never to the host page. */
export function WhiteboardEmbed({ pageId, editable, height, onHeight, actions }: {
  pageId: string; editable: boolean; height?: number | undefined;
  /** Present when the host can store a new height. */
  onHeight?: ((height: number) => void) | undefined;
  actions?: ReactNode;
}) {
  const embeds = useEmbeddedPages();
  const blocked = useEmbedBlocked(pageId);
  if (!embeds) return <div className="nb-embed-placeholder">白板（此处不显示内容）</div>;
  if (blocked) return <EmbedLink pageId={pageId} embeds={embeds} fallbackIcon="🎨" note="嵌套层级已到上限，点击打开白板" actions={actions} />;
  return <LiveBoard pageId={pageId} embeds={embeds} editable={editable} height={height ?? whiteboardViewHeight.initial}
    onHeight={onHeight} actions={actions} />;
}
