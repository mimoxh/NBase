import { describe, expect, it } from 'vitest';
import type { PageProperty, PropertyDefinition } from '@nbase/contracts';
import {
  addMarkdownFrontMatter, createContentFromMarkdown, getMarkdownFrontMatter, pagePropertiesFrontMatter, parseMarkdownImport,
  propertiesFromFrontMatter, readMarkdownFrontMatter, rowPropertiesFrontMatter,
} from './markdown';

const shape = (properties: PageProperty[]) => properties.map(({ name, type, value }) => ({ name, type, value }));

describe('page properties in Markdown front matter', () => {
  it('turns unknown scalar keys into typed properties and keeps lists, maps and date as metadata', () => {
    const { properties, metadata } = propertiesFromFrontMatter({
      date: '2024-02-29', 预算: 12.5, 截止: '2026-12-01', 会议: '2026-12-01T08:00:00Z', 负责人: '青柠', 空: '', 完成: true, 无: null,
      列表: ['a', 'b'], 结构: { a: 1 }, Title: '保留名', Author: '甲', author: '乙',
    });
    expect(shape(properties)).toEqual([
      { name: '预算', type: 'number', value: 12.5 },
      { name: '截止', type: 'date', value: '2026-12-01' },
      { name: '会议', type: 'date', value: '2026-12-01T08:00:00Z' },
      { name: '负责人', type: 'text', value: '青柠' },
      { name: '空', type: 'text', value: null },
      { name: '完成', type: 'text', value: 'true' },
      { name: '无', type: 'text', value: null },
      { name: 'Author', type: 'text', value: '甲' },
    ]);
    // Names that repeat without case, or that the header reserves, stay as they were.
    expect(metadata).toEqual({ date: '2024-02-29', 列表: ['a', 'b'], 结构: { a: 1 }, Title: '保留名', author: '乙' });
  });

  it('exports page properties after the tags, skips empty values and writes option names', () => {
    const properties: PageProperty[] = [
      { id: '00000000-0000-4000-8000-000000000001', name: '状态', type: 'select', value: '00000000-0000-4000-8000-0000000000aa',
        options: [{ id: '00000000-0000-4000-8000-0000000000aa', name: '进行中', color: 'blue' }] },
      { id: '00000000-0000-4000-8000-000000000002', name: '预算', type: 'number', value: 3 },
      { id: '00000000-0000-4000-8000-000000000003', name: '备注', type: 'text', value: null },
      { id: '00000000-0000-4000-8000-000000000004', name: '编号', type: 'text', value: '007' },
    ];
    const markdown = addMarkdownFrontMatter('正文', createContentFromMarkdown('正文'), '页', ['甲'], pagePropertiesFrontMatter(properties));
    expect(markdown.split('\n---\n')[0]).toBe('---\ntitle: 页\ntags:\n  - 甲\n状态: 进行中\n预算: 3\n编号: "007"');
    const imported = parseMarkdownImport(markdown);
    expect(shape(imported.pageProperties)).toEqual([
      { name: '状态', type: 'text', value: '进行中' },
      { name: '预算', type: 'number', value: 3 },
      { name: '编号', type: 'text', value: '007' },
    ]);
  });

  it('lets a property replace a metadata key of the same name', () => {
    const content = parseMarkdownImport('---\nauthor: [甲, 乙]\nsource: 网页\n---\n\n正文').content;
    expect(getMarkdownFrontMatter(content)).toEqual({ author: ['甲', '乙'] });
    const markdown = addMarkdownFrontMatter('正文', content, '页', [], { Author: '丙' });
    expect(readMarkdownFrontMatter(markdown).metadata).toEqual({ Author: '丙' });
  });

  it('exports row values under the field names of the database', () => {
    const option = (id: string, name: string) => ({ id, name, color: 'default' as const });
    const ids = Array.from({ length: 10 }, (_, index) => `00000000-0000-4000-8000-00000000000${index}`);
    const definitions: PropertyDefinition[] = [
      { id: ids[0]!, name: '名称', type: 'title' },
      { id: ids[1]!, name: '文本', type: 'text' },
      { id: ids[2]!, name: '数字', type: 'number' },
      { id: ids[3]!, name: '单选', type: 'select', options: [option(ids[8]!, '高')] },
      { id: ids[4]!, name: '多选', type: 'multi_select', options: [option(ids[8]!, '甲'), option(ids[9]!, '乙')] },
      { id: ids[5]!, name: '完成', type: 'checkbox' },
      { id: ids[6]!, name: 'Date', type: 'date' },
      { id: ids[7]!, name: '已删', type: 'text', deletedAt: '2026-01-01T00:00:00.000Z' },
    ];
    expect(rowPropertiesFrontMatter(definitions, {
      [ids[1]!]: '内容', [ids[2]!]: 2, [ids[3]!]: ids[8]!, [ids[4]!]: [ids[9]!, ids[8]!], [ids[5]!]: true, [ids[6]!]: '2026-01-02', [ids[7]!]: '旧',
    })).toEqual({ 文本: '内容', 数字: 2, 单选: '高', 多选: ['乙', '甲'], 完成: true });
  });
});
