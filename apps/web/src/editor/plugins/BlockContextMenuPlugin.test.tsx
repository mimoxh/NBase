// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentEditor } from '../DocumentEditor';
import type { DocumentEditorHandle } from '../types';
import { createRef } from 'react';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() });
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.querySelectorAll('.nbase-menu').forEach(element => element.remove());
  vi.unstubAllGlobals();
});

async function mount(markdown: string, readOnly = false) {
  const ref = createRef<DocumentEditorHandle>();
  await act(() => root.render(<DocumentEditor ref={ref} documentId="context-menu" initialMarkdown={markdown} readOnly={readOnly} onChange={() => {}} />));
  return ref;
}

function rightClick(target: Element, init: MouseEventInit = {}) {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}

const menu = (label: string) => document.querySelector<HTMLElement>(`.nbase-menu[aria-label="${label}"]`);
async function pick(label: string, item: string) {
  const button = [...menu(label)!.querySelectorAll('button')].find(element => element.textContent?.includes(item));
  if (!button) throw new Error(`No menu item ${item}`);
  await act(() => button.click());
}

describe('block context menu', () => {
  it('runs table actions from a right-click on a cell', async () => {
    const ref = await mount('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |');
    const event = rightClick(host.querySelector('td')!);
    expect(event.defaultPrevented).toBe(true);
    expect(menu('表格操作')).not.toBeNull();
    expect(document.activeElement?.getAttribute('data-menu-key')).toBe('row-above');
    expect(menu('表格操作')!.querySelector<HTMLButtonElement>('[data-menu-key="merge"]')!.disabled).toBe(true);
    await pick('表格操作', '在下方插入行');
    expect(menu('表格操作')).toBeNull();
    expect(host.querySelectorAll('table tr')).toHaveLength(3);
    rightClick(host.querySelector('td')!);
    await pick('表格操作', '列对齐');
    await pick('列对齐', '居中');
    expect(ref.current!.getSnapshot().markdown).toContain(':---:');
  });

  it('keeps the browser menu for ordinary text, Shift+right-click and read-only views', async () => {
    await mount('普通段落\n\n| 甲 |\n| --- |\n| 1 |');
    expect(rightClick(host.querySelector('p')!).defaultPrevented).toBe(false);
    expect(rightClick(host.querySelector('td')!, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(document.querySelector('.nbase-menu')).toBeNull();
    await act(() => root.unmount());
    root = createRoot(host);
    await mount('| 甲 |\n| --- |\n| 1 |', true);
    expect(rightClick(host.querySelector('td')!).defaultPrevented).toBe(false);
    expect(document.querySelector('.nbase-menu')).toBeNull();
  });

  it('changes a code block language from the menu and the corner badge', async () => {
    const ref = await mount('```js\nlet a = 1;\n```');
    rightClick(host.querySelector('code')!);
    await pick('代码块操作', '代码语言');
    expect(menu('代码语言')!.querySelector('[aria-checked="true"]')?.textContent).toContain('JavaScript');
    await pick('代码语言', 'Python');
    expect(ref.current!.getSnapshot().markdown).toContain('```python');
    await act(() => new Promise(resolve => setTimeout(resolve, 100)));
    const badge = host.querySelector<HTMLButtonElement>('button.nbase-code-lang')!;
    expect(badge.textContent).toBe('Python');
    await act(() => badge.click());
    expect(document.activeElement?.getAttribute('data-menu-key')).toBe('lang-python');
    await pick('代码语言', 'Rust');
    expect(ref.current!.getSnapshot().markdown).toContain('```rust');
  });

  it('changes callout type, title and unwraps it', async () => {
    const ref = await mount('> [!NOTE]\n> 内容');
    const callout = () => host.querySelector('aside.nbase-callout');
    rightClick(callout()!.querySelector('p')!);
    await pick('提示块操作', '提示类型');
    await pick('提示类型', '注意');
    expect(callout()!.getAttribute('data-callout-kind')).toBe('WARNING');
    rightClick(callout()!.querySelector('p')!);
    await pick('提示块操作', '添加标题');
    const input = document.querySelector<HTMLInputElement>('.nbase-callout-title-form input')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '小心');
      input.form!.requestSubmit();
    });
    expect(callout()!.getAttribute('aria-label')).toBe('注意 · 小心');
    expect(document.querySelector('.nbase-callout-title-form')).toBeNull();
    rightClick(callout()!.querySelector('p')!);
    await pick('提示块操作', '转换为普通正文');
    expect(callout()).toBeNull();
    expect(ref.current!.getSnapshot().plainText).toContain('内容');
  });

  it('closes with Escape without changing the document', async () => {
    const ref = await mount('| 甲 |\n| --- |\n| 1 |');
    const before = ref.current!.getSnapshot().markdown;
    rightClick(host.querySelector('td')!);
    await act(() => { menu('表格操作')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(menu('表格操作')).toBeNull();
    expect(ref.current!.getSnapshot().markdown).toBe(before);
  });
});
