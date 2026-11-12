import { describe, expect, it } from 'vitest';
import { createConnector, createShape, type El } from '../model';
import { approximateMeasure } from '../text';
import { boardToSvg, exportBounds, exportSet } from './export';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('SVG export', () => {
  it('serialises every element type as standalone, escaped markup', () => {
    const a = { ...createShape(id(1), { x: 0, y: 0, w: 120, h: 80 }), text: '开始 <b>&' };
    const b = { ...createShape(id(2), { x: 300, y: 0, w: 120, h: 80 }, { shape: 'diamond' }), angle: Math.PI / 4 };
    const elements: El[] = [
      { id: id(9), type: 'frame', x: -40, y: -40, w: 600, h: 300, angle: 0, name: '第一页' },
      a, b,
      createConnector(id(3), { x: 0, y: 0, bind: { elementId: a.id, ax: 1, ay: 0.5 } }, { x: 0, y: 0, bind: { elementId: b.id, ax: 0, ay: 0.5 } }),
      { id: id(4), type: 'note', x: 0, y: 120, w: 200, h: 100, angle: 0, text: '便签', color: '#fff3b0', fontSize: 16, textAlign: 'left' },
      { id: id(5), type: 'pen', x: 0, y: 240, w: 20, h: 20, angle: 0, points: [0, 0, 10, 20, 20, 0], color: '#e5484d', strokeWidth: 3 },
      { id: id(6), type: 'image', x: 250, y: 120, w: 80, h: 60, angle: 0, attachmentId: id(60), fileName: 'a.png', mediaType: 'image/png' },
      { id: id(7), type: 'card', x: 250, y: 200, w: 200, h: 60, angle: 0, pageId: id(70), label: '已删除的页面' },
    ];
    const svg = boardToSvg(elements, new Map([[id(60), 'data:image/png;base64,AAAA']]), { measure: approximateMeasure, pageInfo: () => null });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('开始 &lt;b&gt;&amp;');
    expect(svg).toContain('第一页');
    expect(svg).toContain('rotate(45)');
    expect(svg).toContain('href="data:image/png;base64,AAAA"');
    expect(svg).toContain('页面不存在或已删除');
    expect(svg).not.toContain('<b>');
    expect((svg.match(/<path /g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it('exports only the selection when asked and pads the bounds', () => {
    const a = createShape(id(1), { x: 0, y: 0, w: 100, h: 100 }), b = createShape(id(2), { x: 500, y: 500, w: 100, h: 100 });
    expect(exportSet([a, b], new Set([b.id]))).toEqual([b]);
    expect(exportBounds([b], 10)).toEqual({ x: 490, y: 490, w: 120, h: 120 });
  });
});
