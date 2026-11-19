import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { WhiteboardShapeKind } from '@nbase/contracts';
import { fillColors, highlighterColors, noteColors, strokeColors } from '../model';
import type { BoardStore, Tool } from '../store';
import { BoardIcon, type BoardIconName } from './icons';

/**
 * Re-render on board changes. `key` narrows that to what a component shows: it re-renders only
 * when the key changes, so chrome that ignores elements stays still while elements are dragged.
 */
export function useBoard(store: BoardStore, key?: (store: BoardStore) => string | number) {
  useSyncExternalStore(store.subscribe, key ? () => key(store) : store.getVersion);
  return store;
}

export const shapeLabels: Record<WhiteboardShapeKind, string> = { rect: '矩形', roundRect: '圆角矩形', ellipse: '椭圆', diamond: '菱形', triangle: '三角形' };
export const colorName = (color: string) => color === 'transparent' ? '无填充' : color;

const tools: { tool: Tool; icon: BoardIconName; label: string; key: string }[] = [
  { tool: 'select', icon: 'select', label: '选择', key: 'V' },
  { tool: 'hand', icon: 'hand', label: '抓手', key: 'H' },
  { tool: 'shape', icon: 'rect', label: '形状', key: 'S' },
  { tool: 'text', icon: 'text', label: '文本', key: 'T' },
  { tool: 'note', icon: 'note', label: '便签', key: 'N' },
  { tool: 'connector', icon: 'connector', label: '连接线', key: 'C' },
  { tool: 'pen', icon: 'pen', label: '画笔', key: 'P' },
  { tool: 'highlighter', icon: 'highlighter', label: '荧光笔', key: 'Shift+P' },
  { tool: 'eraser', icon: 'eraser', label: '橡皮擦', key: 'E' },
  { tool: 'frame', icon: 'frame', label: '框架', key: 'F' },
  { tool: 'mind', icon: 'mind', label: '思维导图', key: 'M' },
];

/** Tools that make one element and then hand back to select; a double-click keeps them picked. */
const lockable = new Set<Tool>(['shape', 'text', 'note', 'connector', 'frame', 'mind']);

export function Swatches({ colors, value, onPick, label }: { colors: readonly string[]; value: string; onPick: (color: string) => void; label: string }) {
  return <div className="wb-swatches" role="radiogroup" aria-label={label}>
    {colors.map(color => <button key={color} type="button" role="radio" aria-checked={color === value} title={colorName(color)} aria-label={colorName(color)}
      className={`wb-swatch ${color === value ? 'on' : ''} ${color === 'transparent' ? 'none' : ''}`} style={{ '--wb-swatch': color } as React.CSSProperties}
      onClick={() => onPick(color)} />)}
  </div>;
}

export function Widths({ values, value, onPick, label }: { values: number[]; value: number; onPick: (width: number) => void; label: string }) {
  return <div className="wb-seg" role="radiogroup" aria-label={label}>
    {values.map(width => <button key={width} type="button" role="radio" aria-checked={width === value} className={width === value ? 'on' : ''}
      title={`${width} px`} onClick={() => onPick(width)}><span className="wb-width" style={{ height: Math.max(1, Math.min(10, width / (values.at(-1)! > 20 ? 4 : 1))) }} /></button>)}
  </div>;
}

function ToolStyleStrip({ store }: { store: BoardStore }) {
  const { tool, style } = store;
  if (tool === 'pen') return <div className="wb-strip"><Swatches label="画笔颜色" colors={strokeColors} value={style.penColor} onPick={penColor => store.setStyle({ penColor })} />
    <Widths label="画笔粗细" values={[2, 3, 6, 10]} value={style.penWidth} onPick={penWidth => store.setStyle({ penWidth })} /></div>;
  if (tool === 'highlighter') return <div className="wb-strip"><Swatches label="荧光笔颜色" colors={highlighterColors} value={style.highlighterColor} onPick={highlighterColor => store.setStyle({ highlighterColor })} />
    <Widths label="荧光笔粗细" values={[12, 18, 28]} value={style.highlighterWidth} onPick={highlighterWidth => store.setStyle({ highlighterWidth })} /></div>;
  if (tool === 'note') return <div className="wb-strip"><Swatches label="便签颜色" colors={noteColors} value={style.noteColor} onPick={noteColor => store.setStyle({ noteColor })} /></div>;
  if (tool === 'shape') return <div className="wb-strip">
    <div className="wb-seg" role="radiogroup" aria-label="形状">
      {(Object.keys(shapeLabels) as WhiteboardShapeKind[]).map(shape => <button key={shape} type="button" role="radio" aria-checked={style.shape === shape}
        className={style.shape === shape ? 'on' : ''} title={shapeLabels[shape]} aria-label={shapeLabels[shape]} onClick={() => store.setStyle({ shape })}><BoardIcon name={shape} size={16} /></button>)}
    </div>
    <Swatches label="填充" colors={fillColors.slice(0, 8)} value={style.fill} onPick={fill => store.setStyle({ fill })} />
  </div>;
  if (tool === 'eraser') return <div className="wb-strip"><div className="wb-seg" role="radiogroup" aria-label="橡皮擦方式">
    {([['element', '整个元素', '碰到的元素整个删除'], ['stroke', '局部擦除', '只擦掉被碰到的部分；形状和连接线会先转成笔画']] as const).map(([mode, label, hint]) =>
      <button key={mode} type="button" role="radio" aria-checked={style.eraserMode === mode} className={style.eraserMode === mode ? 'on' : ''} title={hint}
        onClick={() => store.setStyle({ eraserMode: mode })}>{label}</button>)}
  </div></div>;
  if (tool === 'connector') return <div className="wb-strip"><div className="wb-seg" role="radiogroup" aria-label="连接线样式">
    {([['straight', '直线'], ['elbow', '折线'], ['curve', '曲线']] as const).map(([mode, label]) => <button key={mode} type="button" role="radio" aria-checked={style.connectorMode === mode}
      className={style.connectorMode === mode ? 'on' : ''} title={label} aria-label={label} onClick={() => store.setStyle({ connectorMode: mode })}><BoardIcon name={mode} size={16} /></button>)}
  </div><Swatches label="线条颜色" colors={strokeColors.slice(0, 8)} value={style.stroke} onPick={stroke => store.setStyle({ stroke })} /></div>;
  return null;
}

/**
 * Whether a horizontally scrolling bar has hidden tools on either side, so narrow screens can show
 * that more tools are there. The active tool is scrolled into view when it changes.
 */
function useScrollHints(active: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const update = useCallback(() => {
    const bar = ref.current;
    if (!bar) return;
    const left = bar.scrollLeft > 2, right = bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 2;
    setEdges(old => old.left === left && old.right === right ? old : { left, right });
  }, []);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [update]);
  useEffect(() => {
    const bar = ref.current;
    const on = bar?.querySelector<HTMLElement>('.wb-tool.on');
    if (!bar || !on || bar.scrollWidth <= bar.clientWidth) return;
    const { offsetLeft: x, offsetWidth: w } = on;
    if (x < bar.scrollLeft) bar.scrollTo({ left: x - 32 });
    else if (x + w > bar.scrollLeft + bar.clientWidth) bar.scrollTo({ left: x + w - bar.clientWidth + 32 });
  }, [active]);
  const scroll = (direction: 1 | -1) => ref.current?.scrollBy({ left: direction * Math.max(120, (ref.current.clientWidth ?? 0) * 0.6), behavior: 'smooth' });
  return { ref, update, scroll, ...edges };
}

export function Toolbar({ store, onImage, onCard, onDatabase, canUpload }: {
  store: BoardStore; onImage: () => void; onCard: () => void; canUpload: boolean;
  /** Absent where the host cannot show databases. */
  onDatabase?: (() => void) | undefined;
}) {
  useBoard(store, s => `${s.tool}|${s.toolLocked}|${s.readOnly}|${s.styleVersion}`);
  const [collapsed, setCollapsed] = useState(false);
  const scroller = useScrollHints(store.tool);
  if (store.readOnly) return <div className="wb-toolbar wb-toolbar-ro" role="toolbar" aria-label="白板工具">
    {tools.slice(0, 2).map(item => <button key={item.tool} type="button" className={`wb-tool ${store.tool === item.tool ? 'on' : ''}`} aria-pressed={store.tool === item.tool}
      title={`${item.label} (${item.key})`} aria-label={item.label} onClick={() => store.setTool(item.tool)}><BoardIcon name={item.icon} /></button>)}
    <span className="wb-ro-note">只读</span>
  </div>;
  return <div className="wb-toolbar-wrap">
    {!collapsed && <ToolStyleStrip store={store} />}
    <div className="wb-toolbar-frame">
    <div className="wb-toolbar" role="toolbar" aria-label="白板工具" ref={scroller.ref} onScroll={scroller.update}>
      {tools.map(item => <button key={item.tool} type="button" className={`wb-tool ${store.tool === item.tool ? 'on' : ''} ${store.tool === item.tool && store.toolLocked ? 'locked' : ''}`} aria-pressed={store.tool === item.tool}
        title={lockable.has(item.tool) ? `${item.label} (${item.key})，双击可连续创建` : `${item.label} (${item.key})`} aria-label={item.label}
        onClick={() => { store.setTool(item.tool); setCollapsed(false); }}
        onDoubleClick={() => { if (lockable.has(item.tool)) store.setTool(item.tool, true); }}>
        <BoardIcon name={item.tool === 'shape' ? store.style.shape : item.icon} />
      </button>)}
      <span className="wb-sep" />
      <button type="button" className="wb-tool" title={canUpload ? '插入图片' : '插入图片（需要可写的已登录工作区）'} aria-label="插入图片" disabled={!canUpload} onClick={onImage}><BoardIcon name="image" /></button>
      <button type="button" className="wb-tool" title="插入页面卡片" aria-label="插入页面卡片" onClick={onCard}><BoardIcon name="card" /></button>
      {onDatabase && <button type="button" className="wb-tool" title="插入数据库视图" aria-label="插入数据库视图" onClick={onDatabase}><BoardIcon name="table" /></button>}
    </div>
    {scroller.left && <button type="button" className="wb-scroll-hint left" tabIndex={-1} aria-label="向左滚动工具栏" onClick={() => scroller.scroll(-1)}>‹</button>}
    {scroller.right && <button type="button" className="wb-scroll-hint right" tabIndex={-1} aria-label="向右滚动工具栏" onClick={() => scroller.scroll(1)}>›</button>}
    </div>
  </div>;
}
