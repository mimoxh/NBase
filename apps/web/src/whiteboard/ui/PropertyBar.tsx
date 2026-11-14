import { useEffect, useState, type ReactNode } from 'react';
import type { WhiteboardArrowhead, WhiteboardShapeKind, WhiteboardStrokeStyle, WhiteboardTextAlign } from '@nbase/contracts';
import type { Controller } from '../controller';
import { toScreen } from '../render/canvas';
import { fillColors, isBox, noteColors, strokeColors, type El } from '../model';
import type { BoardStore } from '../store';
import { BoardIcon, type BoardIconName } from './icons';
import { shapeLabels, Swatches, useBoard, Widths } from './Toolbar';

type Panel = 'fill' | 'stroke' | 'text' | 'note' | 'shape' | 'arrows' | 'align' | 'font' | null;

function Btn({ icon, label, onClick, on = false, disabled = false, children }: { icon?: BoardIconName; label: string; onClick: () => void; on?: boolean; disabled?: boolean; children?: ReactNode }) {
  return <button type="button" className={`wb-pbtn ${on ? 'on' : ''}`} title={label} aria-label={label} aria-pressed={on} disabled={disabled} onClick={onClick}>
    {icon && <BoardIcon name={icon} size={16} />}{children}</button>;
}

const dot = (color: string) => <span className={`wb-dot ${color === 'transparent' ? 'none' : ''}`} style={{ '--wb-swatch': color } as React.CSSProperties} />;
const fontSizes = [12, 14, 16, 20, 24, 32, 48, 64, 96];
const strokeStyles: [WhiteboardStrokeStyle, string][] = [['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线']];
const arrowheads: [WhiteboardArrowhead, string][] = [['none', '无'], ['arrow', '箭头'], ['triangle', '三角'], ['dot', '圆点'], ['diamond', '菱形']];

export function PropertyBar({ store, controller, onMore, onPresentFrame, onFitCard }: {
  store: BoardStore; controller: Controller; onMore: (x: number, y: number) => void; onPresentFrame: (id: string) => void;
  /** Present where page previews can be shown; resizes a preview card to its content. */
  onFitCard?: ((id: string) => void) | undefined;
}) {
  useBoard(store);
  const [panel, setPanel] = useState<Panel>(null);
  const selectionKey = [...store.selection].join(',');
  useEffect(() => { setPanel(null); }, [selectionKey]);
  const selected = [...store.selection].map(id => store.index.get(id)).filter((el): el is El => Boolean(el));
  if (!selected.length || store.editingId || store.activeEmbedId || store.inGesture || store.readOnly) return null;
  const bounds = controller.selectionBounds();
  if (!bounds) return null;
  const top = toScreen({ x: bounds.x + bounds.w / 2, y: bounds.y }, store.view);
  const bottom = toScreen({ x: bounds.x, y: bounds.y + bounds.h }, store.view);
  // Prefer above the selection; flip below when it would leave the viewport.
  // Leave room for the rotate handle drawn above the selection.
  const above = top.y - 90 > 8;
  const style = { left: Math.min(Math.max(top.x, 160), Math.max(160, store.size.width - 160)), top: above ? top.y - 86 : Math.min(bottom.y + 34, store.size.height - 56) };
  const of = <T extends El['type']>(type: T) => selected.filter((el): el is Extract<El, { type: T }> => el.type === type);
  const shapes = of('shape'), notes = of('note'), texts = of('text'), connectors = of('connector'), pens = of('pen'), frames = of('frame'), cards = of('card');
  const locked = selected.every(el => el.locked);
  const toggle = (next: Panel) => setPanel(panel === next ? null : next);
  const stroke = shapes[0]?.stroke ?? connectors[0]?.stroke ?? pens[0]?.color;
  const strokeWidth = shapes[0]?.strokeWidth ?? connectors[0]?.strokeWidth ?? pens[0]?.strokeWidth ?? 2;
  const strokeStyle = shapes[0]?.strokeStyle ?? connectors[0]?.strokeStyle ?? 'solid';
  const textual = [...shapes, ...notes, ...texts];
  const fontSize = textual[0]?.fontSize ?? 16;
  const textAlign: WhiteboardTextAlign = textual[0]?.textAlign ?? 'left';
  const grouped = selected.some(el => el.groupId);
  const multi = selected.length > 1;

  const items: ReactNode[] = [];
  if (locked) items.push(<Btn key="unlock" icon="unlock" label="解锁 (Ctrl+Shift+L)" onClick={() => controller.toggleLock()} />);
  else {
    if (shapes.length && shapes.every(el => el.mindParentId === undefined)) items.push(<Btn key="shape" label="形状" on={panel === 'shape'} onClick={() => toggle('shape')}><BoardIcon name={shapes[0]!.shape} size={16} /></Btn>);
    if (shapes.length) items.push(<Btn key="fill" label="填充颜色" on={panel === 'fill'} onClick={() => toggle('fill')}>{dot(shapes[0]!.fill)}</Btn>);
    if (notes.length) items.push(<Btn key="note" label="便签颜色" on={panel === 'note'} onClick={() => toggle('note')}>{dot(notes[0]!.color)}</Btn>);
    if (stroke) items.push(<Btn key="stroke" label="线条" on={panel === 'stroke'} onClick={() => toggle('stroke')}><span className="wb-ring" style={{ '--wb-swatch': stroke } as React.CSSProperties} /></Btn>);
    if (connectors.length) {
      const c = connectors[0]!;
      items.push(<Btn key="mode" icon={c.mode} label={`连线类型：${c.mode === 'elbow' ? '折线' : c.mode === 'curve' ? '曲线' : '直线'}`}
        onClick={() => controller.style({ mode: c.mode === 'straight' ? 'elbow' : c.mode === 'elbow' ? 'curve' : 'straight' })} />);
      items.push(<Btn key="arrows" icon={c.startArrow !== 'none' && c.endArrow !== 'none' ? 'arrowBoth' : c.endArrow !== 'none' ? 'arrowEnd' : c.startArrow !== 'none' ? 'arrowStart' : 'arrowNone'}
        label="箭头" on={panel === 'arrows'} onClick={() => toggle('arrows')} />);
    }
    if (textual.length) {
      items.push(<Btn key="font" label="字号" on={panel === 'font'} onClick={() => toggle('font')}><span className="wb-fs">{fontSize}</span></Btn>);
      items.push(<Btn key="align" icon={textAlign === 'center' ? 'textCenter' : textAlign === 'right' ? 'textRight' : 'textLeft'} label="文本对齐"
        onClick={() => controller.style({ textAlign: textAlign === 'left' ? 'center' : textAlign === 'center' ? 'right' : 'left' })} />);
    }
    if (shapes.length || texts.length) items.push(<Btn key="color" label="文字颜色" on={panel === 'text'} onClick={() => toggle('text')}><span className="wb-tc" style={{ '--wb-swatch': shapes[0]?.textColor ?? texts[0]?.color ?? '#1f2328' } as React.CSSProperties}>A</span></Btn>);
    if (texts.length) items.push(<Btn key="bold" icon="bold" label="加粗" on={texts.every(el => el.bold)} onClick={() => controller.style({ bold: !texts.every(el => el.bold) })} />);
    if (cards.length === 1 && !multi) items.push(<Btn key="open" icon="open" label="打开页面" onClick={() => controller.openCard(cards[0]!.id)} />);
    if (cards.length === 1 && !multi && onFitCard) {
      const preview = cards[0]!.view === 'preview';
      items.push(<Btn key="view" label={preview ? '显示为标签' : '显示为正文预览（双击可就地编辑）'} on={preview}
        onClick={() => controller.setCardView(cards[0]!.id, preview ? 'chip' : 'preview')}><span className="wb-fs">预览</span></Btn>);
      if (preview) items.push(<Btn key="fit" label="高度适应内容" onClick={() => onFitCard(cards[0]!.id)}><span className="wb-fs">适高</span></Btn>);
    }
    if (selected.length === 1 && selected[0]!.type === 'database') items.push(<Btn key="open-db" icon="open" label="打开数据库" onClick={() => controller.openCard(selected[0]!.id)} />);
    if (frames.length === 1 && !multi) items.push(<Btn key="present" icon="play" label="从此框架开始放映" onClick={() => onPresentFrame(frames[0]!.id)} />);
    if (multi) {
      items.push(<Btn key="alignment" icon="alignLeft" label="对齐与分布" on={panel === 'align'} onClick={() => toggle('align')} />);
      items.push(grouped ? <Btn key="ungroup" icon="ungroup" label="取消编组 (Ctrl+Shift+G)" onClick={() => controller.ungroup()} />
        : <Btn key="group" icon="group" label="编组 (Ctrl+G)" onClick={() => controller.group()} />);
    } else if (grouped) items.push(<Btn key="ungroup" icon="ungroup" label="取消编组 (Ctrl+Shift+G)" onClick={() => controller.ungroup()} />);
    items.push(<Btn key="lock" icon="lock" label="锁定 (Ctrl+Shift+L)" onClick={() => controller.toggleLock()} />);
  }
  items.push(<Btn key="more" icon="more" label="更多操作" onClick={() => onMore(style.left, style.top + 40)} />);

  return <div className="wb-pbar" style={style} role="toolbar" aria-label="所选元素属性" onPointerDown={event => event.stopPropagation()}>
    <div className="wb-pbar-row">{items}</div>
    {panel && <div className={`wb-pop ${above ? '' : 'wb-pop-up'}`}>
      {panel === 'shape' && <div className="wb-seg">{(Object.keys(shapeLabels) as WhiteboardShapeKind[]).map(shape => <button key={shape} type="button" className={shapes[0]!.shape === shape ? 'on' : ''}
        title={shapeLabels[shape]} aria-label={shapeLabels[shape]} onClick={() => controller.style({ shape })}><BoardIcon name={shape} size={16} /></button>)}</div>}
      {panel === 'fill' && <Swatches label="填充颜色" colors={fillColors} value={shapes[0]!.fill} onPick={fill => controller.style({ fill })} />}
      {panel === 'note' && <Swatches label="便签颜色" colors={noteColors} value={notes[0]!.color} onPick={noteColor => controller.style({ noteColor })} />}
      {panel === 'text' && <Swatches label="文字颜色" colors={strokeColors} value={shapes[0]?.textColor ?? texts[0]?.color ?? ''} onPick={textColor => controller.style({ textColor })} />}
      {panel === 'stroke' && <>
        <Swatches label="线条颜色" colors={shapes.length ? ['transparent', ...strokeColors] : strokeColors} value={stroke ?? ''} onPick={color => controller.style(color === 'transparent' ? { strokeWidth: 0 } : { stroke: color, ...(strokeWidth === 0 ? { strokeWidth: 2 } : {}) })} />
        <div className="wb-pop-row">
          <Widths label="线条粗细" values={pens.length && !shapes.length && !connectors.length ? [2, 3, 6, 10] : [1, 2, 4, 6]} value={strokeWidth} onPick={width => controller.style({ strokeWidth: width })} />
          {(shapes.length > 0 || connectors.length > 0) && <div className="wb-seg" role="radiogroup" aria-label="线型">{strokeStyles.map(([value, label]) =>
            <button key={value} type="button" role="radio" aria-checked={strokeStyle === value} className={strokeStyle === value ? 'on' : ''} onClick={() => controller.style({ strokeStyle: value })}>
              <span className={`wb-line wb-line-${value}`} aria-hidden="true" /><span className="visually-hidden">{label}</span></button>)}</div>}
        </div>
      </>}
      {panel === 'arrows' && connectors[0] && <div className="wb-pop-col">
        {(['startArrow', 'endArrow'] as const).map(which => <div key={which} className="wb-pop-row"><span className="wb-pop-label">{which === 'startArrow' ? '起点' : '终点'}</span>
          <div className="wb-seg">{arrowheads.map(([value, label]) => <button key={value} type="button" className={connectors[0]![which] === value ? 'on' : ''}
            onClick={() => controller.style({ [which]: value })}>{label}</button>)}</div></div>)}
      </div>}
      {panel === 'font' && <div className="wb-seg">{fontSizes.map(size => <button key={size} type="button" className={fontSize === size ? 'on' : ''} onClick={() => controller.style({ fontSize: size })}>{size}</button>)}</div>}
      {panel === 'align' && <div className="wb-seg">
        {([['left', 'alignLeft', '左对齐'], ['hcenter', 'alignHCenter', '水平居中'], ['right', 'alignRight', '右对齐'], ['top', 'alignTop', '顶部对齐'],
          ['vcenter', 'alignVCenter', '垂直居中'], ['bottom', 'alignBottom', '底部对齐']] as const).map(([how, icon, label]) =>
          <button key={how} type="button" title={label} aria-label={label} onClick={() => controller.align(how)}><BoardIcon name={icon} size={16} /></button>)}
        <button type="button" title="水平等距分布" aria-label="水平等距分布" disabled={selected.length < 3} onClick={() => controller.distribute('x')}><BoardIcon name="distributeH" size={16} /></button>
        <button type="button" title="垂直等距分布" aria-label="垂直等距分布" disabled={selected.length < 3} onClick={() => controller.distribute('y')}><BoardIcon name="distributeV" size={16} /></button>
      </div>}
    </div>}
  </div>;
}

export const selectionHasBoxes = (store: BoardStore) => [...store.selection].some(id => { const el = store.index.get(id); return el ? isBox(el) : false; });
