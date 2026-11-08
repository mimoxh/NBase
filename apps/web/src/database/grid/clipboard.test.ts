import { describe, expect, it } from 'vitest';
import type { PropertyDefinition } from '@nbase/contracts';
import { parseCellText, parseTsv, toTsv } from './clipboard';

const opt = (id: string, name: string) => ({ id, name, color: 'blue' as const });
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const def = (type: PropertyDefinition['type']): PropertyDefinition => ({ id: a, name: 'x', type, options: [opt(a, '甲'), opt(b, '乙')] });

describe('grid clipboard', () => {
  it('round-trips rectangles and flattens line breaks inside cells', () => {
    expect(parseTsv(toTsv([['a', 'b\tc'], ['d\ne', '']]))).toEqual([['a', 'b c'], ['d e', '']]);
  });

  it('reads the quoting spreadsheets use', () => {
    expect(parseTsv('"多\n行"\t"含""引号"\r\n2\t3\r\n')).toEqual([['多\n行', '含"引号'], ['2', '3']]);
    expect(parseTsv('单值')).toEqual([['单值']]);
  });

  it('converts text to field values and refuses what does not fit', () => {
    expect(parseCellText(def('number'), ' 1,234.5 ')).toEqual({ ok: true, value: 1234.5 });
    expect(parseCellText(def('number'), 'abc')).toEqual({ ok: false });
    expect(parseCellText(def('date'), '2026/1/5')).toEqual({ ok: true, value: '2026-01-05' });
    expect(parseCellText(def('date'), '2026-02-31')).toEqual({ ok: false });
    expect(parseCellText(def('checkbox'), '✓')).toEqual({ ok: true, value: true });
    expect(parseCellText(def('checkbox'), '否')).toEqual({ ok: true, value: null });
    expect(parseCellText(def('checkbox'), '也许')).toEqual({ ok: false });
    expect(parseCellText(def('select'), '乙')).toEqual({ ok: true, value: b });
    expect(parseCellText(def('select'), '丙')).toEqual({ ok: false });
    expect(parseCellText(def('multi_select'), '甲，乙')).toEqual({ ok: true, value: [a, b] });
    expect(parseCellText(def('multi_select'), '甲, 丙')).toEqual({ ok: false });
    expect(parseCellText(def('url'), 'example.com')).toEqual({ ok: true, value: 'https://example.com' });
    expect(parseCellText(def('url'), 'javascript:alert(1)')).toEqual({ ok: false });
    expect(parseCellText(def('text'), '   ')).toEqual({ ok: true, value: null });
    expect(parseCellText(def('created_time'), '2026-01-01')).toEqual({ ok: false });
  });
});
