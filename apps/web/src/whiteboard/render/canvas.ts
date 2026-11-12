import type { WhiteboardCard, WhiteboardTextAlign } from '@nbase/contracts';
import { aabb, centerOf, expandRect, rectsIntersect, type Box, type Point, type Rect, type SnapGuide } from '../geometry';
import { connectorPath, elementBounds, handlePoint, handles, isBox, notePadding, penPoints, shapeTextBox, type BoxEl, type Connector,
  type ConnectorPath, type El, type Elements, type Index } from '../model';
import { isMindNode } from '../mind';
import { fontOf, lineHeightOf, wrapText, type Measure } from '../text';
import { noteInk, themed, type Theme } from './colors';
import { arrowheadPath, connectorLinePath, dashArray, mindEdgePath, roundedRectPath, shapePath, strokePath } from './paths';

export interface View { x: number; y: number; zoom: number }
export const toScreen = (p: Point, view: View): Point => ({ x: (p.x - view.x) * view.zoom, y: (p.y - view.y) * view.zoom });
export const toWorldPoint = (p: Point, view: View): Point => ({ x: p.x / view.zoom + view.x, y: p.y / view.zoom + view.y });
export const visibleWorld = (view: View, width: number, height: number): Rect => ({ x: view.x, y: view.y, w: width / view.zoom, h: height / view.zoom });

export type PageInfo = { title: string; icon: string | null } | null;
export type Background = 'dots' | 'grid' | 'none';

export interface ImageSource { get(attachmentId: string): HTMLImageElement | 'loading' | 'error' }

export interface SceneOptions {
  theme: Theme;
  measure: Measure;
  images: ImageSource;
  pageInfo: (pageId: string) => PageInfo;
  /** Elements whose text is being edited in the DOM overlay. */
  hideText?: ReadonlySet<string>;
  /** Elements about to be erased draw faded. */
  faded?: ReadonlySet<string>;
  background: Background;
  /** Export draws a plain background and skips culling. */
  exporting?: boolean;
}

/** Measures with a shared 2D context and remembers results; text widths are the hot path when drawing. */
export function createMeasure(): Measure {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = canvas?.getContext('2d') ?? null;
  const cache = new Map<string, number>();
  return (text, fontSize, bold) => {
    const key = `${fontSize}|${bold ? 1 : 0}|${text}`;
    const known = cache.get(key);
    if (known !== undefined) return known;
    let width: number;
    if (ctx) { ctx.font = fontOf(fontSize, bold); width = ctx.measureText(text).width; }
    else width = text.length * fontSize * 0.6;
    if (cache.size > 20_000) cache.clear();
    cache.set(key, width);
    return width;
  };
}

const wrapCache = new Map<string, string[]>();
export function wrapped(text: string, width: number, fontSize: number, bold: boolean, measure: Measure): string[] {
  const key = `${Math.round(width)}|${fontSize}|${bold ? 1 : 0}|${text}`;
  const known = wrapCache.get(key);
  if (known) return known;
  const lines = wrapText(text, width, fontSize, bold, measure);
  if (wrapCache.size > 5000) wrapCache.clear();
  wrapCache.set(key, lines);
  return lines;
}

function withBox(ctx: CanvasRenderingContext2D, box: Box, draw: () => void) {
  ctx.save();
  const c = centerOf(box);
  ctx.translate(c.x, c.y);
  if (box.angle) ctx.rotate(box.angle);
  ctx.translate(-box.w / 2, -box.h / 2);
  draw();
  ctx.restore();
}

function drawLines(ctx: CanvasRenderingContext2D, lines: string[], area: Rect, fontSize: number, bold: boolean, align: WhiteboardTextAlign,
  color: string, vertical: 'top' | 'middle') {
  const lineHeight = lineHeightOf(fontSize);
  const total = lines.length * lineHeight;
  let y = vertical === 'middle' ? area.y + (area.h - total) / 2 : area.y;
  ctx.font = fontOf(fontSize, bold);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = align;
  const x = align === 'left' ? area.x : align === 'right' ? area.x + area.w : area.x + area.w / 2;
  for (const line of lines) { ctx.fillText(line, x, y + lineHeight / 2); y += lineHeight; }
}

function stroke(ctx: CanvasRenderingContext2D, color: string, width: number, style: 'solid' | 'dashed' | 'dotted') {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dashArray(style, width));
  ctx.lineCap = style === 'dotted' ? 'round' : 'round'; ctx.lineJoin = 'round';
}

function truncate(text: string, width: number, fontSize: number, bold: boolean, measure: Measure): string {
  if (measure(text, fontSize, bold) <= width) return text;
  let value = text;
  while (value.length > 1 && measure(`${value}…`, fontSize, bold) > width) value = value.slice(0, -1);
  return `${value}…`;
}

export function cardTitle(el: WhiteboardCard, info: PageInfo): string {
  return info ? info.title || '未命名页面' : el.label || '未命名页面';
}

function drawCard(ctx: CanvasRenderingContext2D, el: WhiteboardCard, options: SceneOptions, zoom: number) {
  const { theme, measure } = options;
  const info = options.pageInfo(el.pageId);
  const outline = new Path2D(roundedRectPath(0, 0, el.w, el.h, Math.min(10, el.h / 3)));
  ctx.shadowColor = theme.shadow; ctx.shadowBlur = options.exporting ? 0 : 8 * Math.min(1, zoom); ctx.shadowOffsetY = 2;
  ctx.fillStyle = theme.cardBg; ctx.fill(outline);
  ctx.shadowColor = 'transparent';
  stroke(ctx, info ? theme.cardLine : theme.danger, 1, info ? 'solid' : 'dashed'); ctx.stroke(outline);
  if (12 * zoom < 3) return;
  const iconSize = Math.min(22, el.h * 0.45);
  ctx.font = fontOf(iconSize); ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillStyle = theme.muted;
  ctx.fillText(info ? info.icon ?? '📄' : '⚠️', 12, el.h / 2);
  const textX = 12 + iconSize + 10, room = el.w - textX - 12;
  const titleSize = Math.min(15, el.h * 0.28);
  ctx.font = fontOf(titleSize, true); ctx.fillStyle = info ? themed('#1f2328', theme.dark) : theme.danger;
  ctx.fillText(truncate(cardTitle(el, info), room, titleSize, true, measure), textX, el.h / 2 - titleSize * 0.65);
  ctx.font = fontOf(titleSize * 0.8); ctx.fillStyle = theme.muted;
  ctx.fillText(truncate(info ? '页面 · 双击打开' : '页面不存在或已删除', room, titleSize * 0.8, false, measure), textX, el.h / 2 + titleSize * 0.75);
}

function drawImage(ctx: CanvasRenderingContext2D, el: Extract<El, { type: 'image' }>, options: SceneOptions) {
  const image = options.images.get(el.attachmentId);
  if (image instanceof HTMLImageElement) { ctx.drawImage(image, 0, 0, el.w, el.h); return; }
  ctx.fillStyle = options.theme.dark ? '#26292d' : '#f1f3f5'; ctx.fillRect(0, 0, el.w, el.h);
  ctx.strokeStyle = options.theme.cardLine; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.strokeRect(0, 0, el.w, el.h);
  ctx.font = fontOf(13); ctx.fillStyle = options.theme.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(image === 'error' ? '图片无法加载' : '图片加载中…', el.w / 2, el.h / 2);
}

function drawBox(ctx: CanvasRenderingContext2D, el: BoxEl, options: SceneOptions, zoom: number) {
  const { theme, measure } = options;
  const dark = theme.dark;
  const textHidden = options.hideText?.has(el.id) ?? false;
  withBox(ctx, el, () => {
    switch (el.type) {
      case 'shape': {
        const outline = new Path2D(shapePath(el.shape, el.w, el.h));
        if (el.fill !== 'transparent') { ctx.fillStyle = themed(el.fill, dark); ctx.fill(outline); }
        if (el.strokeWidth > 0) { stroke(ctx, themed(el.stroke, dark), el.strokeWidth, el.strokeStyle); ctx.stroke(outline); }
        if (el.text && !textHidden && el.fontSize * zoom >= 3) {
          const area = shapeTextBox(el);
          drawLines(ctx, wrapped(el.text, area.w, el.fontSize, false, measure), area, el.fontSize, false, el.textAlign, themed(el.textColor, dark), 'middle');
        }
        break;
      }
      case 'note': {
        const paper = new Path2D(roundedRectPath(0, 0, el.w, el.h, 6));
        if (!options.exporting) { ctx.shadowColor = theme.shadow; ctx.shadowBlur = 10 * Math.min(1, zoom); ctx.shadowOffsetY = 3; }
        ctx.fillStyle = themed(el.color, dark); ctx.fill(paper);
        ctx.shadowColor = 'transparent';
        if (el.text && !textHidden && el.fontSize * zoom >= 3) {
          const area = { x: notePadding, y: notePadding, w: el.w - notePadding * 2, h: el.h - notePadding * 2 };
          drawLines(ctx, wrapped(el.text, area.w, el.fontSize, false, measure), area, el.fontSize, false, el.textAlign, noteInk(dark), 'top');
        }
        break;
      }
      case 'text':
        if (!textHidden && el.fontSize * zoom >= 2) {
          drawLines(ctx, wrapped(el.text, el.w, el.fontSize, Boolean(el.bold), measure), { x: 0, y: 0, w: el.w, h: el.h }, el.fontSize,
            Boolean(el.bold), el.textAlign, themed(el.color, dark), 'top');
        }
        break;
      case 'frame':
        ctx.fillStyle = theme.frameFill; ctx.fillRect(0, 0, el.w, el.h);
        ctx.strokeStyle = theme.frameStroke; ctx.lineWidth = 1 / zoom; ctx.setLineDash([]); ctx.strokeRect(0, 0, el.w, el.h);
        break;
      case 'image': drawImage(ctx, el, options); break;
      case 'card': drawCard(ctx, el, options, zoom); break;
      case 'pen': break;
    }
  });
  if (el.type === 'pen') {
    const path = new Path2D(strokePath(penPoints(el)));
    ctx.save();
    if (el.highlighter) ctx.globalAlpha *= 0.38;
    stroke(ctx, themed(el.color, dark), el.strokeWidth, 'solid');
    ctx.lineCap = el.highlighter ? 'square' : 'round';
    ctx.stroke(path);
    ctx.restore();
  }
}

function drawConnector(ctx: CanvasRenderingContext2D, el: Connector, path: ConnectorPath, options: SceneOptions, zoom: number) {
  const color = themed(el.stroke, options.theme.dark);
  stroke(ctx, color, el.strokeWidth, el.strokeStyle);
  ctx.stroke(new Path2D(connectorLinePath(path)));
  ctx.setLineDash([]);
  const ends: [typeof el.startArrow, Point, Point][] = [[el.startArrow, path.points[0]!, path.startDirection], [el.endArrow, path.points.at(-1)!, path.endDirection]];
  for (const [kind, tip, direction] of ends) {
    const head = arrowheadPath(kind, tip, direction, el.strokeWidth);
    if (!head) continue;
    const shape = new Path2D(head.d);
    if (head.filled) { ctx.fillStyle = color; ctx.fill(shape); ctx.stroke(shape); } else ctx.stroke(shape);
  }
  if (el.text && !options.hideText?.has(el.id) && 14 * zoom >= 3) {
    const at = connectorLabelPoint(path);
    const lines = el.text.split('\n');
    const width = Math.max(...lines.map(line => options.measure(line, 14, false))) + 12;
    const height = lines.length * lineHeightOf(14) + 4;
    ctx.fillStyle = options.theme.labelBg; ctx.fillRect(at.x - width / 2, at.y - height / 2, width, height);
    drawLines(ctx, lines, { x: at.x - width / 2, y: at.y - height / 2, w: width, h: height }, 14, false, 'center', themed('#1f2328', options.theme.dark), 'middle');
  }
}

export function connectorLabelPoint(path: ConnectorPath): Point {
  if (path.curve) return path.points[Math.floor(path.points.length / 2)]!;
  let total = 0;
  for (let i = 1; i < path.points.length; i += 1) total += Math.hypot(path.points[i]!.x - path.points[i - 1]!.x, path.points[i]!.y - path.points[i - 1]!.y);
  let walked = 0;
  for (let i = 1; i < path.points.length; i += 1) {
    const a = path.points[i - 1]!, b = path.points[i]!;
    const segment = Math.hypot(b.x - a.x, b.y - a.y);
    if (walked + segment >= total / 2 && segment > 0) { const t = (total / 2 - walked) / segment; return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
    walked += segment;
  }
  return path.points[0]!;
}

function drawBackground(ctx: CanvasRenderingContext2D, view: View, width: number, height: number, options: SceneOptions) {
  ctx.fillStyle = options.theme.canvas;
  ctx.fillRect(0, 0, width, height);
  if (options.background === 'none') return;
  // Keep the on-screen spacing between 14 and 56 px by doubling the world step as needed.
  let step = 24;
  while (step * view.zoom < 14) step *= 2;
  while (step * view.zoom > 56) step /= 2;
  const screenStep = step * view.zoom;
  const offsetX = -((view.x % step) + step) % step * view.zoom, offsetY = -((view.y % step) + step) % step * view.zoom;
  if (options.background === 'dots') {
    ctx.fillStyle = options.theme.dot;
    const size = Math.max(1, Math.min(2, view.zoom * 1.5));
    for (let x = offsetX; x < width; x += screenStep) for (let y = offsetY; y < height; y += screenStep) ctx.fillRect(x - size / 2, y - size / 2, size, size);
  } else {
    ctx.strokeStyle = options.theme.grid; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.beginPath();
    for (let x = offsetX; x < width; x += screenStep) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, height); }
    for (let y = offsetY; y < height; y += screenStep) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(width, Math.round(y) + 0.5); }
    ctx.stroke();
  }
}

export interface SceneStats { drawn: number; total: number }

/** Draw the board with the view transform; elements outside the visible area are skipped. */
export function drawScene(ctx: CanvasRenderingContext2D, elements: Elements, index: Index, view: View, width: number, height: number,
  options: SceneOptions): SceneStats {
  drawBackground(ctx, view, width, height, options);
  ctx.save();
  ctx.scale(view.zoom, view.zoom);
  ctx.translate(-view.x, -view.y);
  const visible = expandRect(visibleWorld(view, width, height), 40 / view.zoom);
  const paths = new Map<string, ConnectorPath>();
  const inView = (el: El): boolean => {
    if (options.exporting) return true;
    if (el.type === 'connector') {
      const path = connectorPath(el, index);
      paths.set(el.id, path);
      return rectsIntersect(visible, elementBounds(el, index));
    }
    return rectsIntersect(visible, expandRect(aabb(el), el.type === 'pen' ? el.strokeWidth : 12));
  };
  // Mind-map edges are derived from the tree and sit underneath every node.
  ctx.lineCap = 'round';
  for (const el of elements) {
    if (!isMindNode(el) || !el.mindParentId) continue;
    const parent = index.get(el.mindParentId);
    if (!parent || !isBox(parent)) continue;
    const from = { x: parent.x + parent.w, y: parent.y + parent.h / 2 }, to = { x: el.x, y: el.y + el.h / 2 };
    if (!options.exporting && !rectsIntersect(visible, { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) })) continue;
    stroke(ctx, themed(el.stroke, options.theme.dark), 2, 'solid');
    ctx.stroke(new Path2D(mindEdgePath(from, to)));
  }
  let drawn = 0;
  const frames: Extract<El, { type: 'frame' }>[] = [];
  for (const el of elements) {
    if (el.type === 'frame') frames.push(el);
    if (!inView(el)) continue;
    drawn += 1;
    const faded = options.faded?.has(el.id);
    if (faded) { ctx.save(); ctx.globalAlpha = 0.25; }
    if (el.type === 'connector') drawConnector(ctx, el, paths.get(el.id) ?? connectorPath(el, index), options, view.zoom);
    else drawBox(ctx, el, options, view.zoom);
    if (faded) ctx.restore();
  }
  // Frame titles stay a constant screen size and are drawn last so content never hides them.
  for (const frame of frames) {
    if (!options.exporting && !rectsIntersect(visible, aabb(frame))) continue;
    if (options.hideText?.has(frame.id)) continue;
    const size = 12 / view.zoom;
    ctx.font = fontOf(size, true); ctx.fillStyle = options.theme.frameLabel; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(truncate(frame.name || '未命名框架', frame.w, size, true, options.measure), frame.x, frame.y - 4 / view.zoom);
  }
  ctx.restore();
  return { drawn, total: elements.length };
}

export interface Overlay {
  /** Outline every selected element individually. */
  outlines: Box[];
  /** The transform box with handles; absent when nothing is selected or the selection cannot transform. */
  transform: { box: Box; handles: boolean; rotate: boolean; locked: boolean } | null;
  connectorEnds: Point[];
  hover: Box | null;
  anchors: { box: Box; points: Point[]; active: Point | null } | null;
  marquee: Rect | null;
  guides: SnapGuide[];
  draft: { points: Point[]; color: string; width: number; highlighter: boolean } | null;
  eraser: Point[] | null;
}

export const emptyOverlay: Overlay = { outlines: [], transform: null, connectorEnds: [], hover: null, anchors: null, marquee: null, guides: [], draft: null, eraser: null };
export const rotateHandleOffset = 26;
export const handleSize = 9;

function boxPath(ctx: CanvasRenderingContext2D, box: Box, view: View) {
  const points = [handlePoint(box, 'nw'), handlePoint(box, 'ne'), handlePoint(box, 'se'), handlePoint(box, 'sw')].map(p => toScreen(p, view));
  ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
}

export function rotateHandlePoint(box: Box, view: View): Point {
  const top = toScreen(handlePoint(box, 'n'), view);
  const angle = box.angle;
  return { x: top.x + Math.sin(angle) * rotateHandleOffset, y: top.y - Math.cos(angle) * rotateHandleOffset };
}

/** Screen-space UI over the scene: selection, handles, guides and in-progress strokes. */
export function drawOverlay(ctx: CanvasRenderingContext2D, overlay: Overlay, view: View, theme: Theme) {
  ctx.save();
  ctx.setLineDash([]);
  if (overlay.draft && overlay.draft.points.length) {
    ctx.save();
    ctx.scale(view.zoom, view.zoom); ctx.translate(-view.x, -view.y);
    if (overlay.draft.highlighter) ctx.globalAlpha = 0.38;
    ctx.strokeStyle = themed(overlay.draft.color, theme.dark); ctx.lineWidth = overlay.draft.width;
    ctx.lineCap = overlay.draft.highlighter ? 'square' : 'round'; ctx.lineJoin = 'round';
    ctx.stroke(new Path2D(strokePath(overlay.draft.points)));
    ctx.restore();
  }
  if (overlay.eraser && overlay.eraser.length > 1) {
    ctx.strokeStyle = theme.dark ? 'rgba(255,255,255,.25)' : 'rgba(0,0,0,.18)'; ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); overlay.eraser.map(p => toScreen(p, view)).forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
  }
  if (overlay.hover) { ctx.strokeStyle = theme.accent; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.5; boxPath(ctx, overlay.hover, view); ctx.stroke(); ctx.globalAlpha = 1; }
  ctx.strokeStyle = theme.accent; ctx.lineWidth = 1;
  for (const box of overlay.outlines) { boxPath(ctx, box, view); ctx.stroke(); }
  const t = overlay.transform;
  if (t) {
    ctx.lineWidth = 1.5; ctx.strokeStyle = t.locked ? theme.muted : theme.accent;
    if (t.locked) ctx.setLineDash([4, 3]);
    boxPath(ctx, t.box, view); ctx.stroke(); ctx.setLineDash([]);
    if (t.handles && !t.locked) {
      ctx.fillStyle = theme.handleFill;
      for (const handle of handles) {
        const p = toScreen(handlePoint(t.box, handle), view);
        ctx.beginPath(); ctx.rect(p.x - handleSize / 2, p.y - handleSize / 2, handleSize, handleSize); ctx.fill(); ctx.stroke();
      }
    }
    if (t.rotate && !t.locked) {
      const top = toScreen(handlePoint(t.box, 'n'), view), knob = rotateHandlePoint(t.box, view);
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(knob.x, knob.y); ctx.stroke();
      ctx.beginPath(); ctx.arc(knob.x, knob.y, 5.5, 0, Math.PI * 2); ctx.fillStyle = theme.handleFill; ctx.fill(); ctx.stroke();
    }
  }
  for (const end of overlay.connectorEnds) {
    const p = toScreen(end, view);
    ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fillStyle = theme.handleFill; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = theme.accent; ctx.stroke();
  }
  if (overlay.anchors) {
    ctx.strokeStyle = theme.accent; ctx.lineWidth = 1.5; boxPath(ctx, overlay.anchors.box, view); ctx.stroke();
    for (const anchor of overlay.anchors.points) {
      const p = toScreen(anchor, view);
      const active = overlay.anchors.active && Math.abs(overlay.anchors.active.x - anchor.x) < 0.01 && Math.abs(overlay.anchors.active.y - anchor.y) < 0.01;
      ctx.beginPath(); ctx.arc(p.x, p.y, active ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = active ? theme.accent : theme.handleFill; ctx.fill(); ctx.stroke();
    }
  }
  if (overlay.marquee) {
    const a = toScreen(overlay.marquee, view);
    ctx.fillStyle = theme.accentSoft; ctx.strokeStyle = theme.accent; ctx.lineWidth = 1;
    ctx.fillRect(a.x, a.y, overlay.marquee.w * view.zoom, overlay.marquee.h * view.zoom);
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, overlay.marquee.w * view.zoom, overlay.marquee.h * view.zoom);
  }
  if (overlay.guides.length) {
    ctx.strokeStyle = theme.dark ? '#ff7aa2' : '#e5484d'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (const guide of overlay.guides) {
      const a = toScreen(guide.axis === 'x' ? { x: guide.position, y: guide.from } : { x: guide.from, y: guide.position }, view);
      const b = toScreen(guide.axis === 'x' ? { x: guide.position, y: guide.to } : { x: guide.to, y: guide.position }, view);
      ctx.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5); ctx.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
    }
    ctx.stroke();
  }
  ctx.restore();
}
