// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DatabaseRow, PageProperty, PropertyDefinition } from '@nbase/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertPageProperty, PageProperties, pagePropertyNameProblem } from './PageProperties';
import { RowProperties } from './RowProperties';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const typeInto = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error('element missing');
  await act(async () => { (element as HTMLElement).click(); });
};
const button = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.includes(label)
  || item.getAttribute('aria-label') === label);

const text: PageProperty = { id: '00000000-0000-4000-8000-000000000001', name: '负责人', type: 'text', value: '青柠' };

describe('page properties', () => {
  it('adds a typed property and refuses reserved or repeated names', async () => {
    const onSave = vi.fn(async (_next: PageProperty[]) => true);
    let adding = true;
    const render = () => root.render(<PageProperties properties={[text]} editable adding={adding}
      onAddingChange={open => { adding = open; render(); }} onSave={onSave} />);
    await act(async () => render());
    const name = document.querySelector<HTMLInputElement>('input[aria-label="属性名称"]')!;
    await typeInto(name, 'Date');
    await click(document.querySelector('form button[type="submit"]'));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('title、tags、date 是保留名称。');
    await typeInto(name, '负责人');
    await click(document.querySelector('form button[type="submit"]'));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('已有同名属性。');
    expect(onSave).not.toHaveBeenCalled();

    await typeInto(name, '预算');
    await click([...document.querySelectorAll('[role="radio"]')].find(item => item.textContent?.includes('数字')));
    await click(document.querySelector('form button[type="submit"]'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toEqual([text, { id: expect.any(String), name: '预算', type: 'number', value: null }]);
    expect(adding).toBe(false);
    expect(host.textContent).toContain('预算');
  });

  it('saves a new select option before the value that uses it, one save at a time', async () => {
    const status: PageProperty = { id: '00000000-0000-4000-8000-000000000002', name: '状态', type: 'select', value: null, options: [] };
    const resolvers: Array<(ok: boolean) => void> = [];
    const onSave = vi.fn((_next: PageProperty[]) => new Promise<boolean>(resolve => resolvers.push(resolve)));
    await act(async () => root.render(<PageProperties properties={[status]} editable adding={false}
      onAddingChange={() => undefined} onSave={onSave} />));
    await click(button('编辑状态'));
    await typeInto(document.querySelector<HTMLInputElement>('input[aria-label="搜索选项"]')!, '高');
    await click(button('新建选项'));
    // The second save waits for the first, so both reach the server in order.
    expect(onSave).toHaveBeenCalledTimes(1);
    const [first] = onSave.mock.calls[0]!;
    const option = first[0]!.options![0]!;
    expect(first).toEqual([{ ...status, options: [{ id: option.id, name: '高', color: expect.any(String) }] }]);
    await act(async () => { resolvers[0]!(true); });
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]![0]).toEqual([{ ...status, value: option.id, options: [option] }]);
    await act(async () => { resolvers[1]!(true); });
    expect(host.textContent).toContain('高');
  });

  it('renames, changes type and deletes from the property menu', async () => {
    const onSave = vi.fn(async (_next: PageProperty[]) => true);
    const number: PageProperty = { id: '00000000-0000-4000-8000-000000000003', name: '编号', type: 'text', value: '42' };
    await act(async () => root.render(<PageProperties properties={[text, number]} editable adding={false}
      onAddingChange={() => undefined} onSave={onSave} />));
    await click(button('属性「编号」的设置'));
    await click([...document.querySelectorAll('[aria-label="属性类型"] button')].find(item => item.textContent?.includes('数字')));
    expect(onSave.mock.calls[0]![0]).toEqual([text, { ...number, type: 'number', value: 42 }]);
    await click(button('属性「负责人」的设置'));
    const input = document.querySelector<HTMLInputElement>('.nb-page-prop-rename input')!;
    await typeInto(input, '编号');
    await act(async () => { input.form!.requestSubmit(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('已有同名属性。');
    await typeInto(input, '作者');
    await act(async () => { input.form!.requestSubmit(); });
    expect(onSave.mock.calls[1]![0].map(item => item.name)).toEqual(['作者', '编号']);
    await click(button('属性「作者」的设置'));
    await click(button('删除属性'));
    expect(onSave.mock.calls[2]![0]).toEqual([{ ...number, type: 'number', value: 42 }]);
  });

  it('shows values without editing controls on a read-only page and hides an empty panel', async () => {
    await act(async () => root.render(<PageProperties properties={[]} editable={false} adding={false}
      onAddingChange={() => undefined} onSave={async () => true} />));
    expect(host.innerHTML).toBe('');
    await act(async () => root.render(<PageProperties properties={[text]} editable={false} adding={false}
      onAddingChange={() => undefined} onSave={async () => true} />));
    expect(host.textContent).toContain('青柠');
    expect(host.querySelector('button')).toBeNull();
  });

  it('converts values when the type changes', () => {
    expect(convertPageProperty({ ...text, value: '12.5' }, 'number').value).toBe(12.5);
    expect(convertPageProperty(text, 'number').value).toBeNull();
    expect(convertPageProperty({ ...text, value: '2026-12-01' }, 'date').value).toBe('2026-12-01');
    const select = convertPageProperty(text, 'select');
    expect(select.options?.map(option => option.name)).toEqual(['青柠']);
    expect(select.value).toBe(select.options![0]!.id);
    expect(convertPageProperty(select, 'text')).toEqual({ id: text.id, name: text.name, type: 'text', value: '青柠' });
    expect(pagePropertyNameProblem('  ', [])).toBe('请输入属性名称。');
    expect(pagePropertyNameProblem('负责人', [text], text.id)).toBe('');
  });
});

describe('row page properties', () => {
  it('adds a field to the database from the row page', async () => {
    const onAddProperty = vi.fn(async () => true);
    const row: DatabaseRow = { id: 'row', title: '行', icon: null, properties: {}, revision: '1', createdAt: '', updatedAt: '' };
    const properties: PropertyDefinition[] = [{ id: '00000000-0000-4000-8000-000000000010', name: '名称', type: 'title' },
      { id: '00000000-0000-4000-8000-000000000011', name: '状态', type: 'select', options: [] }];
    await act(async () => root.render(<RowProperties row={row} properties={properties} editable pending={false}
      onChange={() => undefined} onAddProperty={onAddProperty} />));
    await click(button('＋ 添加属性'));
    const name = document.querySelector<HTMLInputElement>('input[aria-label="属性名称"]')!;
    await typeInto(name, '状态');
    await click(document.querySelector('form button[type="submit"]'));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('数据库里已有同名字段。');
    await typeInto(name, '截止');
    await click([...document.querySelectorAll('[role="radio"]')].find(item => item.textContent?.includes('日期')));
    await click(document.querySelector('form button[type="submit"]'));
    expect(onAddProperty).toHaveBeenCalledWith('截止', 'date');
    expect(document.querySelector('input[aria-label="属性名称"]')).toBeNull();
  });

  it('offers no add button without schema access', async () => {
    const row: DatabaseRow = { id: 'row', title: '行', icon: null, properties: {}, revision: '1', createdAt: '', updatedAt: '' };
    await act(async () => root.render(<RowProperties row={row} properties={[]} editable pending={false} onChange={() => undefined} />));
    expect(button('＋ 添加属性')).toBeUndefined();
  });
});
