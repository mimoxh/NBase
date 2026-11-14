import type { WhiteboardTextAlign } from '@nbase/contracts';
import { centerOf, expandRect, type Box, type Rect } from '../geometry';
import { boundsOfIds, connectorPath, indexElements, isBox, notePadding, penPoints, shapeTextBox, type El, type Elements } from '../model';
import { isMindNode } from '../mind';
import { fontFamily, lineHeightOf, type Measure } from '../text';
import { cardTitle, connectorLabelPoint, drawScene, wrapped, type ImageSource, type PageInfo } from './canvas';
import { lightTheme, noteInk, themed, type Theme } from './colors';
import { arrowheadPath, connectorLinePath, dashArray, mindEdgePath, roundedRectPath, shapePath, strokePath } from './paths';

export interface ExportOptions {
  measure: Measure;
  pageInfo: (pageId: string) => PageInfo;
  theme?: Theme;
  padding?: number;
}

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const num = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2);

/** Elements to export: the selection plus everything that a selected frame contains, in board order. */
export function exportSet(elements: Elements, ids: ReadonlySet<string> | null): El[] {
  if (!ids) return [...elements];
  return elements.filter(el => ids.has(el.id));
}

export function exportBounds(elements: Elements, padding: number): Rect | null {
  const index = indexElements(elements);
  const bounds = boundsOfIds(elements.map(el => el.id), index);
  if (!bounds) return null;
  // Frame titles sit above the frame.
  const titled = elements.some(el => el.type === 'frame') ? { ...bounds, y: bounds.y - 20, h: bounds.h + 20 } : bounds;
  return expandRect(titled, padding);
}

function transform(box: Box): string {
  const c = centerOf(box);
  const deg = box.angle * 180 / Math.PI;
  return deg ? `translate(${num(c.x)} ${num(c.y)}) rotate(${num(deg)}) translate(${num(-box.w / 2)} ${num(-box.h / 2)})` : `translate(${num(box.x)} ${num(box.y)})`;
}

function textLines(lines: string[], area: Rect, fontSize: number, bold: boolean, align: WhiteboardTextAlign, color: string, vertical: 'top' | 'middle'): string {
  const lineHeight = lineHeightOf(fontSize);
  const top = vertical === 'middle' ? area.y + (area.h - lines.length * lineHeight) / 2 : area.y;
  const x = align === 'left' ? area.x : align === 'right' ? area.x + area.w : area.x + area.w / 2;
  const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
  const spans = lines.map((line, i) => `<tspan x="${num(x)}" y="${num(top + lineHeight * i + lineHeight / 2)}">${escape(line) || ' '}</tspan>`).join('');
  return `<text font-size="${num(fontSize)}"${bold ? ' font-weight="600"' : ''} fill="${color}" text-anchor="${anchor}" dominant-baseline="central" xml:space="preserve">${spans}</text>`;
}

const strokeAttrs = (color: string, width: number, style: 'solid' | 'dashed' | 'dotted') => {
  const dash = dashArray(style, width);
  return `stroke="${color}" stroke-width="${num(width)}" stroke-linecap="round" stroke-linejoin="round"${dash.length ? ` stroke-dasharray="${dash.map(num).join(' ')}"` : ''}`;
};

/**
 * Serialise elements as standalone SVG. Images must be supplied as data URLs so the file has no
 * dependency on the session that made it.
 */
export function boardToSvg(elements: Elements, images: ReadonlyMap<string, string>, options: ExportOptions): string {
  const theme = options.theme ?? lightTheme;
  const dark = theme.dark;
  const bounds = exportBounds(elements, options.padding ?? 32) ?? { x: 0, y: 0, w: 100, h: 100 };
  const index = indexElements(elements);
  const parts: string[] = [];
  for (const el of elements) {
    if (!isMindNode(el) || !el.mindParentId) continue;
    const parent = index.get(el.mindParentId);
    if (!parent || !isBox(parent)) continue;
    parts.push(`<path d="${mindEdgePath({ x: parent.x + parent.w, y: parent.y + parent.h / 2 }, { x: el.x, y: el.y + el.h / 2 })}" fill="none" ${strokeAttrs(themed(el.stroke, dark), 2, 'solid')}/>`);
  }
  const titles: string[] = [];
  for (const el of elements) {
    if (el.type === 'connector') {
      const path = connectorPath(el, index);
      const color = themed(el.stroke, dark);
      parts.push(`<path d="${connectorLinePath(path)}" fill="none" ${strokeAttrs(color, el.strokeWidth, el.strokeStyle)}/>`);
      for (const [kind, tip, direction] of [[el.startArrow, path.points[0]!, path.startDirection], [el.endArrow, path.points.at(-1)!, path.endDirection]] as const) {
        const head = arrowheadPath(kind, tip, direction, el.strokeWidth);
        if (head) parts.push(`<path d="${head.d}" fill="${head.filled ? color : 'none'}" ${strokeAttrs(color, el.strokeWidth, 'solid')}/>`);
      }
      if (el.text) {
        const at = connectorLabelPoint(path);
        const lines = el.text.split('\n');
        const w = Math.max(...lines.map(line => options.measure(line, 14, false))) + 12, h = lines.length * lineHeightOf(14) + 4;
        const area = { x: at.x - w / 2, y: at.y - h / 2, w, h };
        parts.push(`<rect x="${num(area.x)}" y="${num(area.y)}" width="${num(w)}" height="${num(h)}" fill="${theme.labelBg}"/>`,
          textLines(lines, area, 14, false, 'center', themed('#1f2328', dark), 'middle'));
      }
      continue;
    }
    if (el.type === 'pen') {
      parts.push(`<path d="${strokePath(penPoints(el))}" fill="none"${el.highlighter ? ' opacity="0.38"' : ''} ${strokeAttrs(themed(el.color, dark), el.strokeWidth, 'solid')}${el.highlighter ? ' stroke-linecap="square"' : ''}/>`);
      continue;
    }
    const body: string[] = [];
    switch (el.type) {
      case 'shape': {
        body.push(`<path d="${shapePath(el.shape, el.w, el.h)}" fill="${el.fill === 'transparent' ? 'none' : themed(el.fill, dark)}" ${el.strokeWidth > 0 ? strokeAttrs(themed(el.stroke, dark), el.strokeWidth, el.strokeStyle) : 'stroke="none"'}/>`);
        if (el.text) {
          const area = shapeTextBox(el);
          body.push(textLines(wrapped(el.text, area.w, el.fontSize, false, options.measure), area, el.fontSize, false, el.textAlign, themed(el.textColor, dark), 'middle'));
        }
        break;
      }
      case 'note': {
        body.push(`<path d="${roundedRectPath(0, 0, el.w, el.h, 6)}" fill="${themed(el.color, dark)}"/>`);
        const area = { x: notePadding, y: notePadding, w: el.w - notePadding * 2, h: el.h - notePadding * 2 };
        if (el.text) body.push(textLines(wrapped(el.text, area.w, el.fontSize, false, options.measure), area, el.fontSize, false, el.textAlign, noteInk(dark), 'top'));
        break;
      }
      case 'text':
        body.push(textLines(wrapped(el.text, el.w, el.fontSize, Boolean(el.bold), options.measure), { x: 0, y: 0, w: el.w, h: el.h }, el.fontSize, Boolean(el.bold), el.textAlign, themed(el.color, dark), 'top'));
        break;
      case 'frame':
        body.push(`<rect width="${num(el.w)}" height="${num(el.h)}" fill="${theme.frameFill}" stroke="${theme.frameStroke}"/>`);
        titles.push(`<text x="${num(el.x)}" y="${num(el.y - 6)}" font-size="12" font-weight="600" fill="${theme.frameLabel}">${escape(el.name || '未命名框架')}</text>`);
        break;
      case 'image': {
        const url = images.get(el.attachmentId);
        body.push(url ? `<image href="${escape(url)}" width="${num(el.w)}" height="${num(el.h)}" preserveAspectRatio="none"/>`
          : `<rect width="${num(el.w)}" height="${num(el.h)}" fill="#f1f3f5" stroke="#dfe3e8"/>`);
        break;
      }
      case 'database': {
        const info = options.pageInfo(el.databaseId);
        body.push(`<path d="${roundedRectPath(0, 0, el.w, el.h, 8)}" fill="${theme.cardBg}" stroke="${theme.cardLine}"/>`,
          `<text x="12" y="24" font-size="16" dominant-baseline="central">${escape(info?.icon ?? '🗃️')}</text>`,
          `<text x="38" y="24" font-size="14" font-weight="600" fill="${themed('#1f2328', dark)}" dominant-baseline="central">${escape(info ? info.title || '未命名数据库' : '数据库视图')}</text>`,
          `<text x="12" y="48" font-size="12" fill="${theme.muted}" dominant-baseline="central">数据库视图 · 导出不包含数据</text>`);
        break;
      }
      case 'card': {
        const info = options.pageInfo(el.pageId);
        if (el.view === 'preview') {
          body.push(`<path d="${roundedRectPath(0, 0, el.w, el.h, 8)}" fill="${theme.cardBg}" stroke="${theme.cardLine}"/>`,
            `<text x="12" y="24" font-size="16" dominant-baseline="central">${escape(info?.icon ?? '📄')}</text>`,
            `<text x="38" y="24" font-size="14" font-weight="600" fill="${themed('#1f2328', dark)}" dominant-baseline="central">${escape(cardTitle(el, info))}</text>`,
            `<text x="12" y="48" font-size="12" fill="${theme.muted}" dominant-baseline="central">页面预览 · 导出不包含正文</text>`);
          break;
        }
        body.push(`<path d="${roundedRectPath(0, 0, el.w, el.h, Math.min(10, el.h / 3))}" fill="${theme.cardBg}" stroke="${info ? theme.cardLine : theme.danger}"${info ? '' : ' stroke-dasharray="4 3"'}/>`,
          `<text x="12" y="${num(el.h / 2)}" font-size="20" dominant-baseline="central">${escape(info ? info.icon ?? '📄' : '⚠️')}</text>`,
          `<text x="44" y="${num(el.h / 2 - 9)}" font-size="15" font-weight="600" fill="${info ? themed('#1f2328', dark) : theme.danger}" dominant-baseline="central">${escape(cardTitle(el, info))}</text>`,
          `<text x="44" y="${num(el.h / 2 + 11)}" font-size="12" fill="${theme.muted}" dominant-baseline="central">${info ? '页面' : '页面不存在或已删除'}</text>`);
        break;
      }
    }
    parts.push(`<g transform="${transform(el)}">${body.join('')}</g>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(bounds.x)} ${num(bounds.y)} ${num(bounds.w)} ${num(bounds.h)}" width="${num(bounds.w)}" height="${num(bounds.h)}" font-family="${escape(fontFamily)}">`
    + `<rect x="${num(bounds.x)}" y="${num(bounds.y)}" width="${num(bounds.w)}" height="${num(bounds.h)}" fill="${theme.canvas}"/>${parts.join('')}${titles.join('')}</svg>`;
}

/** Raster export through the on-screen renderer; images must already be loaded in `images`. */
export async function boardToPng(elements: Elements, images: ImageSource, options: ExportOptions & { scale?: number }): Promise<Blob | null> {
  const bounds = exportBounds(elements, options.padding ?? 32);
  if (!bounds) return null;
  // Browsers cap canvas area; scale down big boards instead of failing.
  const scale = Math.min(options.scale ?? 2, Math.sqrt(32_000_000 / Math.max(1, bounds.w * bounds.h)), 16_000 / Math.max(bounds.w, bounds.h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(bounds.w * scale)); canvas.height = Math.max(1, Math.ceil(bounds.h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  drawScene(ctx, elements, indexElements(elements), { x: bounds.x, y: bounds.y, zoom: scale }, canvas.width, canvas.height,
    { theme: options.theme ?? lightTheme, measure: options.measure, images, pageInfo: options.pageInfo, background: 'none', exporting: true });
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}
