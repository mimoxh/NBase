import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { whiteboardContent, whiteboardLimits, type WhiteboardContent } from '@nbase/contracts';
import { downloadBlob } from '../persistence/fileDownload';
import { clipboardMime, pageIdFromPastedText, parseElements, plainText, serializeElements } from './clipboard';
import { Controller, type PointerInput } from './controller';
import { ImageCache } from './images';
import { isMindNode } from './mind';
import { type El } from './model';
import { createMeasure, drawOverlay, drawScene, toWorldPoint, type PageInfo } from './render/canvas';
import { darkTheme, lightTheme } from './render/colors';
import { boardToPng, boardToSvg, exportSet } from './render/export';
import { BoardStore } from './store';
import { BoardIcon } from './ui/icons';
import { ContextMenu, Minimap, PagePicker, Presentation, ZoomBar, type ContextItem, type PickablePage } from './ui/Panels';
import { PropertyBar } from './ui/PropertyBar';
import { TextEditor } from './ui/TextEditor';
import { EmbedLayer, embedContentHeight } from './ui/EmbedLayer';
import { useEmbeddedPages } from '../embed/source';
import { Toolbar, useBoard } from './ui/Toolbar';
import './whiteboard.css';

export interface UploadedImage { id: string; fileName: string; mediaType: string }

export interface WhiteboardViewProps {
  /** The page id; changes in content are reported with it so a late callback cannot land on another page. */
  boardId: string;
  content: WhiteboardContent;
  readOnly: boolean;
  title: string;
  /** Pages that page cards can point to; a card whose page is absent shows as missing. */
  pages: readonly PickablePage[];
  onChange: (boardId: string, content: WhiteboardContent) => void;
  onOpenPage: (pageId: string) => void;
  imageUrl: (attachmentId: string) => string | null;
  /** Absent where images cannot be uploaded (viewers, history previews). */
  onUploadImages?: ((files: File[]) => Promise<UploadedImage[]>) | undefined;
  onNotice: (text: string) => void;
  /** Inside another page: the wheel scrolls the host page until the board has focus. */
  embedded?: boolean | undefined;
  /** Called once with the loaded content, before any change. */
  onReady?: ((boardId: string, content: WhiteboardContent) => void) | undefined;
}

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** In-app copy buffer: some browsers strip custom clipboard types, so the last copy is matched by its plain text. */
let lastCopy: { plain: string; payload: string } | null = null;

function useDarkTheme() {
  const read = () => document.documentElement.dataset.theme === 'dark';
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

export function WhiteboardView(props: WhiteboardViewProps) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const measure = useMemo(() => createMeasure(), []);
  const dark = useDarkTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef(0);
  const drawRef = useRef<() => void>(() => undefined);
  const devicePixelsRef = useRef<{ width: number; height: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedule = useCallback(() => {
    if (frameRef.current || timerRef.current) return;
    const run = () => {
      cancelAnimationFrame(frameRef.current); frameRef.current = 0;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      drawRef.current();
    };
    // Hidden or occluded views may never get an animation frame; the timer keeps the canvas current anyway.
    frameRef.current = requestAnimationFrame(run);
    timerRef.current = setTimeout(run, document.visibilityState === 'hidden' ? 50 : 120);
  }, []);
  const images = useMemo(() => new ImageCache(id => propsRef.current.imageUrl(id), schedule), [schedule]);
  const [menu, setMenu] = useState<{ x: number; y: number; targetId: string | null } | null>(null);
  const [picker, setPicker] = useState<'page' | 'database' | null>(null);
  const embeds = useEmbeddedPages();
  const canDatabase = Boolean(embeds?.editor?.databases);
  const [presenting, setPresenting] = useState<number | null>(null);
  const [cursor, setCursor] = useState('default');

  const store = useMemo(() => new BoardStore(props.content.board.elements as El[], props.readOnly,
    elements => propsRef.current.onChange(propsRef.current.boardId, whiteboardContent(elements))),
  // A different page or loaded revision remounts the view, so the store is created once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  []);
  const controller = useMemo(() => new Controller(store, {
    measure,
    newId: () => crypto.randomUUID(),
    openPage: id => propsRef.current.onOpenPage(id),
    contextMenu: (screen, targetId) => setMenu({ x: screen.x, y: screen.y, targetId }),
    notice: text => propsRef.current.onNotice(text),
  }), [store, measure]);
  useBoard(store);

  useEffect(() => {
    store.readOnly = props.readOnly;
    if (props.readOnly) { store.editingId = null; if (store.tool !== 'hand') store.tool = 'select'; }
    controller.refreshOverlay();
  }, [props.readOnly, store, controller]);

  const pageMap = useMemo(() => new Map(props.pages.map(page => [page.id.toLowerCase(), page])), [props.pages]);
  const pageInfo = useCallback((id: string): PageInfo => {
    const page = pageMap.get(id.toLowerCase());
    return page ? { title: page.title, icon: page.icon } : null;
  }, [pageMap]);

  drawRef.current = () => {
    const canvas = canvasRef.current, ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = store.size;
    // The exact device-pixel box keeps one canvas pixel per screen pixel; a rounded CSS size
    // at fractional scales makes the browser resample, and blur, the whole board. A box that
    // disagrees with the current ratio is stale (or emulated) and falls back to rounding.
    const device = devicePixelsRef.current;
    const usable = device && Math.abs(device.width - width * dpr) <= 1 && Math.abs(device.height - height * dpr) <= 1;
    const pixelWidth = Math.max(1, usable ? device.width : Math.round(width * dpr));
    const pixelHeight = Math.max(1, usable ? device.height : Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth; canvas.height = pixelHeight;
    }
    ctx.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
    const theme = dark ? darkTheme : lightTheme;
    drawScene(ctx, store.elements, store.index, store.view, width, height, {
      theme, measure, images, pageInfo, background: store.background, faded: store.faded,
      ...(store.editingId ? { hideText: new Set([store.editingId]) } : {}),
    });
    drawOverlay(ctx, store.overlay, store.view, theme);
  };
  useEffect(() => store.subscribe(schedule), [store, schedule]);
  useEffect(() => { propsRef.current.onReady?.(propsRef.current.boardId, propsRef.current.content); }, []);
  useEffect(() => { schedule(); }, [dark, pageInfo, schedule]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') schedule(); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      document.removeEventListener('visibilitychange', visible);
      // Reset the ids too: an effect re-run (StrictMode, remount) must be able to schedule again.
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
      frameRef.current = 0; timerRef.current = null;
    };
  }, [schedule]);
  // The first draw does not wait for a store change.
  useEffect(() => { schedule(); }, [schedule]);

  // Size the canvas to its container; the first measurement also places the initial view.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let first = true;
    const observer = new ResizeObserver(() => {
      const box = container.getBoundingClientRect();
      store.size = { width: Math.max(1, box.width), height: Math.max(1, box.height) };
      if (first) {
        first = false;
        if (store.elements.length) store.zoomToFit();
        else store.setView({ x: -store.size.width / 2, y: -store.size.height / 2, zoom: 1 });
      } else store.emit();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [store]);

  // Track the canvas size in device pixels so a scale change (another monitor, OS or browser zoom) redraws sharply.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(entries => {
      const size = entries.at(-1)?.devicePixelContentBoxSize?.[0];
      devicePixelsRef.current = size ? { width: size.inlineSize, height: size.blockSize } : null;
      schedule();
    });
    try { observer.observe(canvas, { box: 'device-pixel-content-box' }); } catch { observer.observe(canvas); }
    let media: MediaQueryList | null = null;
    const watchScale = () => {
      media?.removeEventListener('change', onScale);
      media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      media.addEventListener('change', onScale);
    };
    function onScale() { watchScale(); schedule(); }
    watchScale();
    return () => { observer.disconnect(); media?.removeEventListener('change', onScale); };
  }, [schedule]);

  // Wheel needs a non-passive listener to stop the page from scrolling or zooming.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      if (propsRef.current.embedded && !containerRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      const box = canvas.getBoundingClientRect();
      controller.wheel({ x: event.clientX - box.left, y: event.clientY - box.top }, event.deltaX, event.deltaY, event.deltaMode, event.ctrlKey || event.metaKey, event.shiftKey);
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, [controller]);

  const local = (event: { clientX: number; clientY: number }) => {
    const box = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const input = (event: React.PointerEvent): PointerInput => ({ ...local(event), button: event.button, pointerId: event.pointerId, pointerType: event.pointerType,
    shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey });

  // ── Insertion ──

  const insertImages = useCallback(async (files: File[], at?: { x: number; y: number }) => {
    const upload = propsRef.current.onUploadImages;
    const accepted = files.filter(file => imageTypes.has(file.type));
    if (!accepted.length) return;
    if (!upload || store.readOnly) { propsRef.current.onNotice('当前白板不能上传图片。'); return; }
    const uploaded = await upload(accepted);
    if (!uploaded.length) return;
    const elements: El[] = [];
    let x = 0;
    for (const item of uploaded) {
      const el = controller.imageElement(item, await images.size(item.id.toLowerCase()));
      elements.push({ ...el, x, y: 0 });
      x += el.w + 24;
    }
    controller.insert(elements, at ? toWorldPoint(at, store.view) : undefined);
  }, [controller, images, store]);

  const chooseImages = () => {
    const picker = document.createElement('input');
    picker.type = 'file'; picker.accept = 'image/png,image/jpeg,image/gif,image/webp'; picker.multiple = true;
    picker.onchange = () => { void insertImages(Array.from(picker.files ?? [])); };
    picker.click();
  };

  const insertCard = (page: PickablePage, at?: { x: number; y: number }) => {
    const database = picker === 'database';
    setPicker(null);
    controller.insert([database ? controller.databaseElement(page) : controller.cardElement(page)], at);
    containerRef.current?.focus();
  };

  // ── Clipboard ──

  const copySelection = useCallback((event: ClipboardEvent, cut: boolean) => {
    const ids = controller.selectionWithDependents();
    if (!ids.size || !event.clipboardData) return;
    const elements = store.elements.filter(el => ids.has(el.id));
    const payload = serializeElements(elements, () => crypto.randomUUID());
    const plain = plainText(elements) || '白板元素';
    event.clipboardData.setData(clipboardMime, payload);
    event.clipboardData.setData('text/plain', plain);
    lastCopy = { plain, payload };
    event.preventDefault();
    if (cut) controller.deleteSelection();
  }, [controller, store]);

  const pasteAt = () => {
    const pointer = controller.pointer;
    return pointer && pointer.x >= 0 && pointer.y >= 0 && pointer.x <= store.size.width && pointer.y <= store.size.height
      ? toWorldPoint(pointer, store.view) : store.center();
  };

  const paste = useCallback((event: ClipboardEvent) => {
    if (store.readOnly || !event.clipboardData) return;
    const data = event.clipboardData;
    const files = Array.from(data.files ?? []).filter(file => imageTypes.has(file.type));
    event.preventDefault();
    if (files.length) { void insertImages(files); return; }
    const plain = data.getData('text/plain');
    const payload = data.getData(clipboardMime) || (lastCopy && plain === lastCopy.plain ? lastCopy.payload : '') || plain;
    const parsed = parseElements(payload);
    if (parsed) {
      // Cards to pages this workspace does not have would make the save fail; drop them.
      const kept = parsed.filter(el => el.type === 'card' ? pageMap.has(el.pageId) : el.type !== 'database' || pageMap.has(el.databaseId));
      if (kept.length < parsed.length) propsRef.current.onNotice('已跳过指向本工作区以外页面的卡片。');
      controller.insert(controller.pasteClones(kept, { x: 0, y: 0 }), pasteAt());
      return;
    }
    const pageId = pageIdFromPastedText(plain);
    const page = pageId ? pageMap.get(pageId) : undefined;
    if (page) { controller.insert([controller.cardElement(page)], pasteAt()); return; }
    if (plain.trim()) controller.insert([controller.textElement(plain.slice(0, whiteboardLimits.maxText))], pasteAt());
    // `pasteAt` reads the live pointer, so it is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, insertImages, pageMap, store]);

  useEffect(() => {
    const active = () => {
      const container = containerRef.current;
      const focused = document.activeElement;
      // A live page on the board handles its own clipboard.
      return Boolean(container && focused && container.contains(focused) && !isTyping(focused) && !focused.closest('.wb-embed-layer'));
    };
    const onCopy = (event: ClipboardEvent) => { if (active()) copySelection(event, false); };
    const onCut = (event: ClipboardEvent) => { if (active() && !store.readOnly) copySelection(event, true); };
    const onPaste = (event: ClipboardEvent) => { if (active()) paste(event); };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => { document.removeEventListener('copy', onCopy); document.removeEventListener('cut', onCut); document.removeEventListener('paste', onPaste); };
  }, [copySelection, paste, store]);

  // Pending text is saved through the normal path before the view goes away.
  useEffect(() => () => { if (store.editingId) controller.finishEditing(); }, [store, controller]);

  // ── Export ──

  const exportBoard = async (format: 'png' | 'svg', selectionOnly: boolean) => {
    const ids = selectionOnly ? controller.selectionWithDependents() : null;
    const elements = exportSet(store.elements, ids);
    if (!elements.length) { props.onNotice('没有可导出的内容。'); return; }
    const imageIds = elements.flatMap(el => el.type === 'image' ? [el.attachmentId] : []);
    const name = `${props.title || '未命名白板'}${selectionOnly ? '-所选' : ''}`;
    try {
      if (format === 'png') {
        await images.ready(imageIds);
        const blob = await boardToPng(elements, images, { measure, pageInfo });
        if (blob) downloadBlob(name, blob, '.png'); else props.onNotice('导出 PNG 失败。');
      } else {
        const svg = boardToSvg(elements, await images.dataUrls(imageIds), { measure, pageInfo });
        downloadBlob(name, new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), '.svg');
      }
    } catch { props.onNotice(`导出 ${format.toUpperCase()} 失败。`); }
  };

  const frames = store.elements.filter(el => el.type === 'frame');
  const presentFrom = (id: string | null) => setPresenting(Math.max(0, id ? frames.findIndex(frame => frame.id === id) : 0));

  // ── Context menu ──

  const menuItems = (): (ContextItem | 'divider')[] => {
    const hasSelection = store.selection.size > 0;
    const target = menu?.targetId ? store.index.get(menu.targetId) : undefined;
    const editable = !store.readOnly;
    const locked = hasSelection && [...store.selection].every(id => store.index.get(id)?.locked);
    const exportItems: ContextItem[] = hasSelection
      ? [{ key: 'png-sel', label: '导出所选为 PNG', onSelect: () => void exportBoard('png', true) }, { key: 'svg-sel', label: '导出所选为 SVG', onSelect: () => void exportBoard('svg', true) }]
      : [{ key: 'png', label: '导出白板为 PNG', onSelect: () => void exportBoard('png', false) }, { key: 'svg', label: '导出白板为 SVG', onSelect: () => void exportBoard('svg', false) }];
    if (!hasSelection) return [
      ...(editable ? [{ key: 'paste', label: '粘贴', shortcut: 'Ctrl+V', onSelect: () => props.onNotice('请使用 Ctrl+V 粘贴。') }, 'divider' as const] : []),
      { key: 'all', label: '全选', shortcut: 'Ctrl+A', onSelect: () => { store.select(store.elements.map(el => el.id)); controller.refreshOverlay(); } },
      { key: 'fit', label: '缩放至适合', shortcut: 'Shift+1', onSelect: () => store.zoomToFit() },
      { key: 'present', label: '放映框架', disabled: !frames.length, onSelect: () => presentFrom(null) },
      'divider', ...exportItems,
    ];
    return [
      ...(target?.type === 'card' || target?.type === 'database' ? [{ key: 'open', label: target.type === 'card' ? '打开页面' : '打开数据库', onSelect: () => controller.openCard(target.id) }, 'divider' as const] : []),
      ...(target?.type === 'frame' && frames.length ? [{ key: 'present', label: '从此框架放映', onSelect: () => presentFrom(target.id) }] : []),
      ...(editable && target && controller.canEdit(target) ? [{ key: 'edit', label: '编辑文字', shortcut: 'Enter', onSelect: () => controller.startEditing(target.id) }] : []),
      ...(editable && isMindNode(target) ? [{ key: 'child', label: '添加子主题', shortcut: 'Tab', onSelect: () => controller.addMindNode('child') }] : []),
      { key: 'copy', label: '复制', shortcut: 'Ctrl+C', onSelect: () => { document.execCommand('copy'); } },
      ...(editable ? [
        { key: 'cut', label: '剪切', shortcut: 'Ctrl+X', disabled: locked, onSelect: () => { document.execCommand('cut'); } },
        { key: 'duplicate', label: '创建副本', shortcut: 'Ctrl+D', onSelect: () => controller.duplicate() },
        'divider' as const,
        { key: 'front', label: '置于顶层', shortcut: 'Ctrl+Shift+]', disabled: locked, onSelect: () => controller.order('front') },
        { key: 'forward', label: '上移一层', shortcut: 'Ctrl+]', disabled: locked, onSelect: () => controller.order('forward') },
        { key: 'backward', label: '下移一层', shortcut: 'Ctrl+[', disabled: locked, onSelect: () => controller.order('backward') },
        { key: 'back', label: '置于底层', shortcut: 'Ctrl+Shift+[', disabled: locked, onSelect: () => controller.order('back') },
        'divider' as const,
        ...(store.selection.size > 1 ? [{ key: 'group', label: '编组', shortcut: 'Ctrl+G', onSelect: () => controller.group() }] : []),
        ...([...store.selection].some(id => store.index.get(id)?.groupId) ? [{ key: 'ungroup', label: '取消编组', shortcut: 'Ctrl+Shift+G', onSelect: () => controller.ungroup() }] : []),
        { key: 'lock', label: locked ? '解锁' : '锁定', shortcut: 'Ctrl+Shift+L', onSelect: () => controller.toggleLock() },
        { key: 'zoom', label: '缩放至所选', shortcut: 'Shift+2', onSelect: () => store.zoomToSelection() },
        'divider' as const,
      ] : [{ key: 'zoom', label: '缩放至所选', shortcut: 'Shift+2', onSelect: () => store.zoomToSelection() }, 'divider' as const]),
      ...exportItems,
      ...(editable ? ['divider' as const, { key: 'delete', label: '删除', shortcut: 'Delete', danger: true, disabled: locked, onSelect: () => controller.deleteSelection() }] : []),
    ];
  };

  const pickable = useMemo(() => props.pages.filter(page => page.id !== props.boardId), [props.pages, props.boardId]);

  return <div ref={containerRef} className={`wb-root ${props.readOnly ? 'wb-readonly' : ''} ${props.embedded ? 'wb-embedded' : ''}`} tabIndex={0} aria-label="白板画布"
    aria-roledescription="白板" style={{ cursor }}
    onKeyDown={event => {
      // While a live page has the input, the board's own shortcuts stay off; Esc hands the input back.
      if (store.activeEmbedId) {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing && !(event.target as HTMLElement).closest?.('.wb-embed-layer')) controller.deactivateEmbed();
        return;
      }
      if (isTyping(event.target) || menu || picker || (event.target as HTMLElement).closest?.('.wb-embed-layer')) return;
      if (event.key === ' ' && !event.repeat) { controller.setSpace(true); setCursor('grab'); event.preventDefault(); return; }
      if (controller.keyDown(event)) event.preventDefault();
    }}
    onKeyUp={event => { if (event.key === ' ') { controller.setSpace(false); setCursor('default'); } }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) controller.setSpace(false); }}
    onDragOver={event => { if (!props.readOnly && event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
    onDrop={event => {
      if (props.readOnly || !event.dataTransfer.files.length) return;
      event.preventDefault();
      void insertImages(Array.from(event.dataTransfer.files), local(event));
    }}>
    <canvas ref={canvasRef} className="wb-canvas"
      onPointerDown={event => {
        // The default mousedown would move focus to the board after a new text editor took it.
        if (event.button !== 2) event.preventDefault();
        containerRef.current?.focus({ preventScroll: true });
        setMenu(null);
        if (event.button !== 2) event.currentTarget.setPointerCapture(event.pointerId);
        controller.pointerDown(input(event));
        setCursor(controller.cursorAt(local(event)));
      }}
      onPointerMove={event => { controller.pointerMove(input(event)); setCursor(controller.cursorAt(local(event))); }}
      onPointerUp={event => { controller.pointerUp(input(event)); setCursor(controller.cursorAt(local(event))); }}
      onPointerCancel={event => controller.pointerCancel(input(event))}
      onDoubleClick={event => controller.doubleClick(local(event))}
      onContextMenu={event => { event.preventDefault(); controller.contextMenu(local(event)); }} />
    <EmbedLayer store={store} controller={controller} onExit={() => containerRef.current?.focus({ preventScroll: true })} />
    <TextEditor store={store} controller={controller} measure={measure} />
    <PropertyBar store={store} controller={controller} onPresentFrame={id => presentFrom(id)}
      onFitCard={embeds ? id => {
        const height = embedContentHeight(containerRef.current, id);
        if (height) controller.setHeight(id, height); else props.onNotice('请先放大到能看清卡片正文，再调整高度。');
      } : undefined}
      onMore={(x, y) => setMenu({ x, y, targetId: [...store.selection][0] ?? null })} />
    <div className="wb-topbar" role="toolbar" aria-label="白板">
      <button type="button" className="wb-pbtn wb-labelled" title="按框架放映" disabled={!frames.length} onClick={() => presentFrom(null)}>
        <BoardIcon name="play" size={16} /><span>放映</span></button>
      <button type="button" className="wb-pbtn wb-labelled" title="导出" onClick={event => {
        const box = event.currentTarget.getBoundingClientRect(), root = containerRef.current!.getBoundingClientRect();
        setMenu({ x: box.left - root.left, y: box.bottom - root.top + 4, targetId: null });
      }}><BoardIcon name="download" size={16} /><span>导出</span></button>
    </div>
    <Toolbar store={store} canUpload={Boolean(props.onUploadImages)} onImage={chooseImages} onCard={() => setPicker('page')}
      onDatabase={canDatabase ? () => setPicker('database') : undefined} />
    <div className="wb-corner">
      <Minimap store={store} dark={dark} />
      <ZoomBar store={store} onFit={() => store.zoomToFit()} />
    </div>
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} bounds={store.size} onClose={() => { setMenu(null); containerRef.current?.focus({ preventScroll: true }); }} />}
    {picker && <PagePicker pages={picker === 'database' ? pickable.filter(page => page.kind === 'database') : pickable}
      {...(picker === 'database' ? { label: '插入数据库视图', placeholder: '搜索数据库' } : {})}
      onPick={page => insertCard(page)} onClose={() => { setPicker(null); containerRef.current?.focus(); }} />}
    {presenting !== null && <Presentation elements={store.elements} index={store.index} start={presenting} measure={measure} images={images}
      pageInfo={pageInfo} dark={dark} onClose={() => { setPresenting(null); containerRef.current?.focus(); }} />}
  </div>;
}

export default WhiteboardView;
