import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { WhiteboardFrame } from '@nbase/contracts';
import { expandRect, unionRects } from '../geometry';
import { boardBounds, type El } from '../model';
import { drawScene, type ImageSource, type PageInfo } from '../render/canvas';
import { darkTheme, lightTheme } from '../render/colors';
import { maxZoom, type BoardStore } from '../store';
import type { Measure } from '../text';
import { BoardIcon } from './icons';
import { useBoard } from './Toolbar';

export interface ContextItem { key: string; label: string; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }

export function ContextMenu({ x, y, items, bounds, onClose }: { x: number; y: number; items: (ContextItem | 'divider')[]; bounds: { width: number; height: number }; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({ left: Math.max(4, Math.min(x, bounds.width - box.width - 4)), top: Math.max(4, Math.min(y, bounds.height - box.height - 4)) });
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y, bounds.width, bounds.height]);
  useEffect(() => {
    const away = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); };
  }, [onClose]);
  return <div ref={ref} className="nb-menu-list wb-context" role="menu" aria-label="白板操作" style={position}
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(at + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    }}>
    {items.map((item, i) => item === 'divider' ? <div key={`d${i}`} className="nb-menu-divider" />
      : <button key={item.key} type="button" role="menuitem" disabled={item.disabled} className={`nb-menu-item ${item.danger ? 'nb-menu-danger' : ''}`}
        onClick={() => { onClose(); item.onSelect(); }}><span>{item.label}</span>{item.shortcut && <kbd className="wb-kbd">{item.shortcut}</kbd>}</button>)}
  </div>;
}

export interface PickablePage { id: string; title: string; icon: string | null; kind?: string | undefined }

export function PagePicker({ pages, onPick, onClose, label = '插入页面卡片', placeholder = '搜索要引用的页面' }: {
  pages: readonly PickablePage[]; onPick: (page: PickablePage) => void; onClose: () => void; label?: string; placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pages.filter(page => !q || (page.title || '未命名页面').toLowerCase().includes(q)).slice(0, 80);
  }, [pages, query]);
  return <div className="wb-modal-scrim" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="wb-modal" role="dialog" aria-modal="true" aria-label={label}>
      <div className="nb-pal-input"><BoardIcon name="search" size={16} />
        <input autoFocus value={query} placeholder={placeholder} aria-label="搜索页面"
          onChange={event => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
            if (event.key === 'ArrowDown') { event.preventDefault(); setActive(Math.min(active + 1, matches.length - 1)); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive(Math.max(active - 1, 0)); }
            if (event.key === 'Enter' && matches[active]) { event.preventDefault(); onPick(matches[active]!); }
          }} /></div>
      <div className="nb-pal-list" role="listbox" aria-label="页面">
        {matches.length ? matches.map((page, i) => <button key={page.id} type="button" role="option" aria-selected={i === active}
          className={`nb-pal-item ${i === active ? 'sel' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => onPick(page)}>
          <span className="nb-page-icon" aria-hidden="true">{page.icon ?? (page.kind === 'database' ? '🗃️' : page.kind === 'whiteboard' ? '🧭' : '📄')}</span>
          <span className="nb-pal-main"><span className="nb-pal-title">{page.title || '未命名页面'}</span></span>
        </button>) : <div className="nb-pal-msg">没有匹配的页面</div>}
      </div>
    </div>
  </div>;
}

export function ZoomBar({ store, onFit }: { store: BoardStore; onFit: () => void }) {
  useBoard(store);
  const backgrounds = { dots: '点阵背景', grid: '网格背景', none: '无背景' } as const;
  return <div className="wb-zoombar" role="toolbar" aria-label="视图">
    {!store.readOnly && <>
      <button type="button" className="wb-pbtn" title="撤销 (Ctrl+Z)" aria-label="撤销" disabled={!store.history.canUndo} onClick={() => store.undo()}><BoardIcon name="undo" size={16} /></button>
      <button type="button" className="wb-pbtn" title="重做 (Ctrl+Shift+Z)" aria-label="重做" disabled={!store.history.canRedo} onClick={() => store.redo()}><BoardIcon name="redo" size={16} /></button>
      <span className="wb-sep" />
    </>}
    <button type="button" className="wb-pbtn" title="缩小 (Ctrl+-)" aria-label="缩小" onClick={() => store.zoomBy(0.8)}><BoardIcon name="zoomOut" size={16} /></button>
    <button type="button" className="wb-pbtn wb-zoom" title="缩放至 100% (Ctrl+0)" aria-label={`当前缩放 ${Math.round(store.view.zoom * 100)}%，点击恢复 100%`} onClick={() => store.resetZoom()}>{Math.round(store.view.zoom * 100)}%</button>
    <button type="button" className="wb-pbtn" title="放大 (Ctrl+=)" aria-label="放大" disabled={store.view.zoom >= maxZoom} onClick={() => store.zoomBy(1.25)}><BoardIcon name="zoomIn" size={16} /></button>
    <button type="button" className="wb-pbtn" title="缩放至适合 (Shift+1)" aria-label="缩放至适合" onClick={onFit}><BoardIcon name="fit" size={16} /></button>
    <button type="button" className={`wb-pbtn wb-hide-narrow ${store.minimap ? 'on' : ''}`} title="小地图" aria-label="小地图" aria-pressed={store.minimap}
      onClick={() => { store.minimap = !store.minimap; store.emit(); }}><BoardIcon name="minimap" size={16} /></button>
    <button type="button" className="wb-pbtn" title={`${backgrounds[store.background]}（点击切换）`} aria-label={backgrounds[store.background]}
      onClick={() => { store.background = store.background === 'dots' ? 'grid' : store.background === 'grid' ? 'none' : 'dots'; store.emit(); }}><BoardIcon name="grid" size={16} /></button>
  </div>;
}

/** Overview of the board; click or drag to move the viewport. */
export function Minimap({ store, dark }: { store: BoardStore; dark: boolean }) {
  useBoard(store);
  const ref = useRef<HTMLCanvasElement>(null);
  const width = 200, height = 132;
  const world = store.minimap ? unionRects([boardBounds(store.elements, store.index) ?? { x: 0, y: 0, w: 1, h: 1 },
    { x: store.view.x, y: store.view.y, w: store.size.width / store.view.zoom, h: store.size.height / store.view.zoom }]) : null;
  const area = world ? expandRect(world, Math.max(world.w, world.h) * 0.05) : null;
  const scale = area ? Math.min(width / area.w, height / area.h) : 1;
  useEffect(() => {
    const canvas = ref.current, ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !area) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const theme = dark ? darkTheme : lightTheme;
    ctx.fillStyle = theme.canvas; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = dark ? '#3a3e45' : '#c9ced6';
    for (const el of store.elements) {
      const b = el.type === 'connector' ? null : { x: el.x, y: el.y, w: el.w, h: el.h };
      if (!b) continue;
      ctx.fillRect((b.x - area.x) * scale, (b.y - area.y) * scale, Math.max(1, b.w * scale), Math.max(1, b.h * scale));
    }
    ctx.strokeStyle = theme.accent; ctx.lineWidth = 1.5;
    ctx.strokeRect((store.view.x - area.x) * scale, (store.view.y - area.y) * scale, store.size.width / store.view.zoom * scale, store.size.height / store.view.zoom * scale);
  });
  if (!store.minimap || !area) return null;
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const wx = area.x + (event.clientX - box.left) / scale, wy = area.y + (event.clientY - box.top) / scale;
    store.setView({ ...store.view, x: wx - store.size.width / 2 / store.view.zoom, y: wy - store.size.height / 2 / store.view.zoom });
  };
  return <canvas ref={ref} className="wb-minimap" style={{ width, height }} aria-label="小地图"
    onPointerDown={event => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); move(event); }}
    onPointerMove={event => { if (event.buttons) move(event); }} />;
}

/** Steps through frames full screen, in board order, with a read-only render of the board. */
export function Presentation({ elements, index, start, measure, images, pageInfo, dark, onClose }: {
  elements: El[]; index: Map<string, El>; start: number; measure: Measure; images: ImageSource; pageInfo: (id: string) => PageInfo; dark: boolean; onClose: () => void;
}) {
  const frames = useMemo(() => elements.filter((el): el is WhiteboardFrame => el.type === 'frame'), [elements]);
  const [at, setAt] = useState(Math.min(start, Math.max(0, frames.length - 1)));
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const root = rootRef.current;
    root?.focus();
    void root?.requestFullscreen?.().catch(() => undefined);
    const resize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    const exit = () => { if (!document.fullscreenElement) resize(); };
    window.addEventListener('resize', resize);
    document.addEventListener('fullscreenchange', exit);
    return () => {
      window.removeEventListener('resize', resize); document.removeEventListener('fullscreenchange', exit);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);
  const frame = frames[at];
  useEffect(() => {
    const canvas = canvasRef.current, ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !frame) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr; canvas.height = size.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = 40;
    const zoom = Math.min((size.width - pad * 2) / frame.w, (size.height - pad * 2) / frame.h);
    const view = { zoom, x: frame.x + frame.w / 2 - size.width / 2 / zoom, y: frame.y + frame.h / 2 - size.height / 2 / zoom };
    drawScene(ctx, elements, index, view, size.width, size.height, { theme: dark ? darkTheme : lightTheme, measure, images, pageInfo, background: 'none' });
  });
  const step = (delta: number) => setAt(value => Math.max(0, Math.min(frames.length - 1, value + delta)));
  return <div ref={rootRef} className="wb-present" tabIndex={-1} role="dialog" aria-modal="true" aria-label="白板放映"
    onKeyDown={event => {
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(event.key)) { event.preventDefault(); step(1); }
      if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(event.key)) { event.preventDefault(); step(-1); }
      if (event.key === 'Home') setAt(0);
      if (event.key === 'End') setAt(frames.length - 1);
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      event.stopPropagation();
    }}>
    {frame ? <canvas ref={canvasRef} style={{ width: size.width, height: size.height }} onClick={() => step(1)} aria-label={frame.name || '未命名框架'} />
      : <div className="wb-present-empty">白板里还没有框架。用框架工具 (F) 圈出要展示的区域，放映时按框架逐页播放。</div>}
    <div className="wb-present-bar">
      <button type="button" className="wb-pbtn" aria-label="上一页" disabled={at <= 0} onClick={() => step(-1)}><BoardIcon name="prev" size={16} /></button>
      <span className="wb-present-count">{frames.length ? `${at + 1} / ${frames.length}` : '0 / 0'}{frame ? ` · ${frame.name || '未命名框架'}` : ''}</span>
      <button type="button" className="wb-pbtn" aria-label="下一页" disabled={at >= frames.length - 1} onClick={() => step(1)}><BoardIcon name="next" size={16} /></button>
      <button type="button" className="wb-pbtn" aria-label="退出放映" onClick={onClose}><BoardIcon name="close" size={16} /></button>
    </div>
  </div>;
}
