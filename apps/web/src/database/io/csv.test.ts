import { describe, expect, it } from 'vitest';
import type { DatabaseRow, PropertyDefinition } from '@nbase/contracts';
import { parseCellText } from '../grid/clipboard';
import { decodeCsv, parseCsv, rowsToCsv, unguard } from './csv';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'];
const columns: PropertyDefinition[] = [
  { id: ids[0]!, name: '名称', type: 'title' }, { id: ids[1]!, name: '备注', type: 'text' }, { id: ids[2]!, name: '数', type: 'number' },
  { id: ids[3]!, name: '选', type: 'select', options: [{ id: ids[4]!, name: '甲', color: 'blue' }] }, { id: ids[5]!, name: '勾', type: 'checkbox' },
];
const row = (title: string, properties: DatabaseRow['properties']): DatabaseRow => ({ id: 'x', title, icon: null, properties, revision: '1', createdAt: '', updatedAt: '' });

describe('csv', () => {
  it('round-trips Chinese text, quotes, line breaks and field values', async () => {
    const source = [row('红楼梦, "上"', { [ids[1]!]: '第一行\n第二行', [ids[2]!]: -1.5, [ids[3]!]: ids[4]!, [ids[5]!]: true }), row('', {})];
    const text = rowsToCsv(source, columns);
    expect(text.startsWith('﻿')).toBe(true);
    const parsed = await parseCsv(text);
    expect(parsed[0]).toEqual(['名称', '备注', '数', '选', '勾']);
    expect(parsed[1]).toEqual(['红楼梦, "上"', '第一行\n第二行', '-1.5', '甲', '✓']);
    expect(parsed).toHaveLength(3);
    expect(parseCellText(columns[2]!, parsed[1]![2]!)).toEqual({ ok: true, value: -1.5 });
    expect(parseCellText(columns[3]!, parsed[1]![3]!)).toEqual({ ok: true, value: ids[4]! });
    expect(parseCellText(columns[4]!, parsed[1]![4]!)).toEqual({ ok: true, value: true });
  });

  it('neutralises spreadsheet formulas in text but keeps negative numbers', async () => {
    const parsed = await parseCsv(rowsToCsv([row('=1+1', { [ids[2]!]: -5, [ids[1]!]: '@cmd' })], columns));
    expect(parsed[1]![0]).toBe("'=1+1");
    expect(parsed[1]![1]).toBe("'@cmd");
    expect(parsed[1]![2]).toBe('-5');
    expect(unguard(parsed[1]![0]!)).toBe('=1+1');
    expect(unguard("'普通")).toBe("'普通");
  });

  it('reads tabs and semicolons, a missing final newline and blank lines', async () => {
    expect(await parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(await parseCsv('a;b\r\n1;2\r\n\r\n3;4\r\n')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
    expect(await parseCsv('a,b\n"x""y",\n')).toEqual([['a', 'b'], ['x"y', '']]);
  });

  it('decodes GBK when the bytes are not valid UTF-8', () => {
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]); // 中文
    expect(decodeCsv(gbk.buffer)).toBe('中文');
    expect(decodeCsv(new TextEncoder().encode('中文').buffer as ArrayBuffer)).toBe('中文');
  });

  it('handles a large file', async () => {
    const lines = ['a,b', ...Array.from({ length: 30000 }, (_, i) => `${i},值${i}`)].join('\n');
    const parsed = await parseCsv(lines);
    expect(parsed).toHaveLength(30001);
    expect(parsed[30000]).toEqual(['29999', '值29999']);
  });
});
