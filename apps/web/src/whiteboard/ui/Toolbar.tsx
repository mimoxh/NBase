import { useState, useSyncExternalStore } from 'react';
import type { WhiteboardShapeKind } from '@nbase/contracts';
import { fillColors, highlighterColors, noteColors, strokeColors } from '../model';
import type { BoardStore, Tool } from '../store';
import { BoardIcon, type BoardIconName } from './icons';

export function useBoard(store: BoardStore) {
  useSyncExternalStore(store.subscribe, store.getVersion);
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
  if (tool === 'connector') return <div className="wb-strip"><div className="wb-seg" role="radiogroup" aria-label="连接线样式">
    {([['straight', '直线'], ['elbow', '折线'], ['curve', '曲线']] as const).map(([mode, label]) => <button key={mode} type="button" role="radio" aria-checked={style.connectorMode === mode}
      className={style.connectorMode === mode ? 'on' : ''} title={label} aria-label={label} onClick={() => store.setStyle({ connectorMode: mode })}><BoardIcon name={mode} size={16} /></button>)}
  </div><Swatches label="线条颜色" colors={strokeColors.slice(0, 8)} value={style.stroke} onPick={stroke => store.setStyle({ stroke })} /></div>;
  return null;
}

export function Toolbar({ store, onImage, onCard, canUpload }: { store: BoardStore; onImage: () => void; onCard: () => void; canUpload: boolean }) {
  useBoard(store);
  const [collapsed, setCollapsed] = useState(false);
  if (store.readOnly) return <div className="wb-toolbar wb-toolbar-ro" role="toolbar" aria-label="白板工具">
    {tools.slice(0, 2).map(item => <button key={item.tool} type="button" className={`wb-tool ${store.tool === item.tool ? 'on' : ''}`} aria-pressed={store.tool === item.tool}
      title={`${item.label} (${item.key})`} aria-label={item.label} onClick={() => store.setTool(item.tool)}><BoardIcon name={item.icon} /></button>)}
    <span className="wb-ro-note">只读</span>
  </div>;
  return <div className="wb-toolbar-wrap">
    {!collapsed && <ToolStyleStrip store={store} />}
    <div className="wb-toolbar" role="toolbar" aria-label="白板工具">
      {tools.map(item => <button key={item.tool} type="button" className={`wb-tool ${store.tool === item.tool ? 'on' : ''}`} aria-pressed={store.tool === item.tool}
        title={`${item.label} (${item.key})`} aria-label={item.label}
        onClick={() => { store.setTool(item.tool); setCollapsed(false); }}>
        <BoardIcon name={item.tool === 'shape' ? store.style.shape : item.icon} />
      </button>)}
      <span className="wb-sep" />
      <button type="button" className="wb-tool" title={canUpload ? '插入图片' : '插入图片（需要可写的已登录工作区）'} aria-label="插入图片" disabled={!canUpload} onClick={onImage}><BoardIcon name="image" /></button>
      <button type="button" className="wb-tool" title="插入页面卡片" aria-label="插入页面卡片" onClick={onCard}><BoardIcon name="card" /></button>
    </div>
  </div>;
}
