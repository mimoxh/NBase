import { memo, useEffect, useRef } from 'react';
import { isWhiteboardContent, type WhiteboardCard, type WhiteboardDatabase } from '@nbase/contracts';
import { LazyDatabaseView } from '../../database/lazy';
import { DocumentEditor } from '../../editor/DocumentEditor';
import type { DocumentContent, DocumentEditorHandle } from '../../editor/types';
import { EmbedPathProvider, embedStateLabel, useEmbedBlocked, useEmbeddedPage, useEmbeddedPages, type EmbeddedPages } from '../../embed/source';
import '../../embed/embed.css';
import type { Controller } from '../controller';
import { isEmbedElement, type El } from '../model';
import { LazyWhiteboard } from '../lazy';
import type { BoardStore } from '../store';
import { useBoard } from './Toolbar';

type EmbedEl = WhiteboardCard | WhiteboardDatabase;

/** At most this many embeds are mounted at once; the rest stay title cards drawn on the canvas. */
const maxLive = 12;
/** Below this size on screen an embed is not readable, so the canvas draws its title instead. */
const minScreen = { w: 150, h: 90 };

function Header({ icon, title, state, hint, onOpen }: { icon: string; title: string; state?: string; hint?: string; onOpen: () => void }) {
  return <div className="wb-embed-head">
    <button type="button" className="nb-embed-title" title="打开页面" onClick={onOpen}><span aria-hidden="true">{icon}</span>{title} ↗</button>
    {state && <span className="nb-embed-state" role="status">{state}</span>}
    <span className="nb-embed-spacer" />{hint && <span className="nb-embed-note">{hint}</span>}
  </div>;
}

/** A page card in preview mode: the page itself, read-only until it is activated by a double click. */
function PageCard({ el, active, embeds }: { el: WhiteboardCard; active: boolean; embeds: EmbeddedPages }) {
  const view = useEmbeddedPage(el.pageId, active);
  const titleRef = useRef('');
  titleRef.current = view.page?.title ?? '';
  const info = embeds.pages.find(page => page.id === el.pageId);
  const page = view.page;
  const title = info?.title ?? page?.title ?? el.label;
  const editing = active && view.writable;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const editorRef = useRef<DocumentEditorHandle>(null);
  const ready = view.status === 'ready';
  // Typing should work right after the double click, without a second click to place the caret.
  useEffect(() => { if (editing && ready) editorRef.current?.focus(); }, [editing, ready, view.epoch]);
  const open = () => embeds.openPage(el.pageId);
  if (view.status === 'loading') return <div className="nb-embed-message" role="status">正在读取页面…</div>;
  if (!page) return <div className="nb-embed-message">{view.status === 'error' ? '页面读取失败。' : '页面不存在或已删除。'}</div>;
  const state = view.saveState === 'idle' ? '' : embedStateLabel[view.saveState];
  if (page.kind === 'database') {
    const source = embeds.editor?.databases?.source;
    return <><Header icon={page.icon ?? '🗃️'} title={title || '未命名数据库'} onOpen={open} hint={active ? 'Esc 退出' : '双击操作'} />
      <div className="wb-embed-scroll">{source ? <LazyDatabaseView source={source} databaseId={el.pageId} compact />
        : <div className="nb-embed-message">数据库视图（此处不显示数据）</div>}</div></>;
  }
  if (isWhiteboardContent(page.content)) {
    return <><Header icon={page.icon ?? '🎨'} title={title || '未命名白板'} onOpen={open} hint={active ? 'Esc 退出' : '双击查看'} />
      <div className="wb-embed-board"><EmbedPathProvider pageId={el.pageId}>
        <LazyWhiteboard key={`${el.pageId}:${view.epoch}`} boardId={el.pageId} content={page.content} readOnly embedded title={title}
          pages={embeds.pages} onChange={() => undefined} onOpenPage={embeds.openPage} imageUrl={embeds.imageUrl} onNotice={embeds.notice} />
      </EmbedPathProvider></div></>;
  }
  if (page.content.schemaVersion !== 1) return <div className="nb-embed-message">暂不能显示此格式版本。</div>;
  return <><Header icon={page.icon ?? '📄'} title={title || '未命名页面'} state={state} onOpen={open}
    hint={editing ? 'Esc 退出编辑' : active ? (view.saveState === 'conflict' ? '只读' : embeds.canWrite ? '此页已在别处编辑，这里只读' : '只读') : embeds.canWrite ? '双击编辑' : '双击阅读'} />
    <div className="wb-embed-scroll wb-embed-doc">
      <DocumentEditor key={`${el.pageId}:${view.epoch}`} ref={editorRef} documentId={el.pageId} title={title} initialContent={page.content as DocumentContent}
        readOnly={!editing} {...embeds.editor} embeds={embeds} onNotice={embeds.notice}
        onChange={(id, snapshot) => { if (editingRef.current) embeds.save(id, titleRef.current, snapshot); }} />
    </div></>;
}

function DatabaseBlock({ el, active, embeds, controller, boardReadOnly }: {
  el: WhiteboardDatabase; active: boolean; embeds: EmbeddedPages; controller: Controller; boardReadOnly: boolean;
}) {
  const source = embeds.editor?.databases?.source;
  const info = embeds.pages.find(page => page.id === el.databaseId);
  return <><Header icon={info?.icon ?? '🗃️'} title={info ? info.title || '未命名数据库' : '数据库'} onOpen={() => embeds.openPage(el.databaseId)}
    hint={active ? 'Esc 退出' : '双击操作'} />
    <div className="wb-embed-scroll">{source ? <LazyDatabaseView source={source} databaseId={el.databaseId} viewId={el.viewId ?? null} compact
      onViewChange={viewId => { if (!boardReadOnly) controller.setDatabaseView(el.id, viewId); }} />
      : <div className="nb-embed-message">数据库视图（此处不显示数据）</div>}</div></>;
}

const EmbedContent = memo(function EmbedContent({ el, active, embeds, controller, boardReadOnly }: {
  el: EmbedEl; active: boolean; embeds: EmbeddedPages; controller: Controller; boardReadOnly: boolean;
}) {
  const targetId = el.type === 'card' ? el.pageId : el.databaseId;
  const blocked = useEmbedBlocked(targetId);
  if (blocked) {
    const info = embeds.pages.find(page => page.id === targetId);
    return <><Header icon={info?.icon ?? '📄'} title={info?.title || '页面'} onOpen={() => embeds.openPage(targetId)} />
      <div className="nb-embed-message">嵌套层级已到上限，点击标题打开。</div></>;
  }
  return el.type === 'card' ? <PageCard el={el} active={active} embeds={embeds} />
    : <DatabaseBlock el={el} active={active} embeds={embeds} controller={controller} boardReadOnly={boardReadOnly} />;
});

/**
 * Live pages on the board. The canvas cannot draw an editor or a table, so these are DOM boxes
 * that follow the viewport. They ignore the pointer until activated, which keeps selecting,
 * moving and resizing on the canvas; an active one takes input until Esc or a click outside.
 */
export function EmbedLayer({ store, controller, onExit }: { store: BoardStore; controller: Controller; onExit: () => void }) {
  useBoard(store);
  const embeds = useEmbeddedPages();
  if (!embeds) return null;
  const { view, size } = store;
  const live: EmbedEl[] = [];
  for (let i = store.elements.length - 1; i >= 0; i -= 1) {
    const el: El = store.elements[i]!;
    if (!isEmbedElement(el)) continue;
    const active = el.id === store.activeEmbedId;
    const x = (el.x - view.x) * view.zoom, y = (el.y - view.y) * view.zoom, w = el.w * view.zoom, h = el.h * view.zoom;
    const visible = w >= minScreen.w && h >= minScreen.h && x < size.width && y < size.height && x + w > 0 && y + h > 0;
    if (active || (visible && live.length < maxLive)) live.push(el);
  }
  if (!live.length) return null;
  return <div className="wb-embed-layer">
    {live.reverse().map(el => {
      const active = el.id === store.activeEmbedId;
      return <div key={el.id} className={`wb-embed ${active ? 'active' : ''}`} data-wb-embed={el.id}
        style={{ width: el.w, height: el.h, transform: `translate(${(el.x - view.x) * view.zoom}px, ${(el.y - view.y) * view.zoom}px) scale(${view.zoom})` }}
        onKeyDown={event => {
          if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
          event.stopPropagation();
          controller.deactivateEmbed();
          onExit();
        }}>
        <div className="wb-embed-box" style={el.angle ? { transform: `rotate(${el.angle}rad)` } : undefined}>
          <EmbedContent el={el} active={active} embeds={embeds} controller={controller} boardReadOnly={store.readOnly} />
        </div>
      </div>;
    })}
  </div>;
}

/** Height of a live document card's content, for "fit to content"; null when the card is not mounted. */
export function embedContentHeight(root: HTMLElement | null, elementId: string): number | null {
  const box = root?.querySelector<HTMLElement>(`[data-wb-embed="${elementId}"]`);
  const content = box?.querySelector<HTMLElement>('.nbase-editor-content');
  const head = box?.querySelector<HTMLElement>('.wb-embed-head');
  if (!content || !head) return null;
  // The editor reserves blank space under the last line for the main page; a card does not need it.
  const last = content.lastElementChild as HTMLElement | null;
  const used = last ? last.offsetTop + last.offsetHeight : content.scrollHeight;
  return Math.ceil(head.offsetHeight + used + 40);
}
