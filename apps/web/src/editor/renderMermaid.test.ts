// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { renderMermaid } from './renderMermaid';

const source = 'flowchart LR\n A[原始私密内容] --> B[完成]';
function frame(): HTMLIFrameElement {
  const element = document.querySelector<HTMLIFrameElement>('.nbase-mermaid-render-frame');
  if (!element) throw new Error('render frame missing');
  return element;
}
function message(element: HTMLIFrameElement, data: unknown, sender: MessageEventSource | null = element.contentWindow) {
  window.dispatchEvent(new MessageEvent('message', { source: sender, origin: 'null', data }));
}
afterEach(() => { vi.useRealTimers(); document.querySelectorAll('iframe').forEach(element => element.remove()); });

it('renders in an opaque, network-restricted document and accepts output only from its own window', async () => {
  const result = renderMermaid(source, new AbortController().signal);
  await vi.waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
  const element = frame();
  expect(element.getAttribute('sandbox')).toBe('allow-scripts');
  const doc = new DOMParser().parseFromString(element.srcdoc, 'text/html');
  const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(doc.querySelector('script[src]')?.getAttribute('src')).toContain('mermaid.min.js');
  expect(element.srcdoc).not.toContain('原始私密内容');
  message(element, { type: 'nbase-mermaid-result', svg: '<svg/>' }, window);
  expect(element.isConnected).toBe(true);
  message(element, { type: 'nbase-mermaid-result', svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>完成</text></svg>' });
  expect((await result).type).toBe('image/svg+xml');
  expect(element.isConnected).toBe(false);
  expect(document.querySelector('svg')).toBeNull();
});

it.each([
  '<svg><script>alert(1)</script></svg>',
  '<svg><foreignObject><div>HTML</div></foreignObject></svg>',
  '<svg><image href="https://outside.invalid"/></svg>',
  '<svg><a href="https://outside.invalid"><text>Link</text></a></svg>',
  '<svg onload="alert(1)"/>',
  '<svg>' + 'x'.repeat(512 * 1024) + '</svg>',
])('rejects active or excessive SVG output %#', async svg => {
  const result = renderMermaid(source, new AbortController().signal);
  const rejection = expect(result).rejects.toThrow('图表输出');
  await vi.waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
  message(frame(), { type: 'nbase-mermaid-result', svg });
  await rejection;
  expect(document.querySelector('iframe')).toBeNull();
});

it('aborts an active preview and removes its sandbox when the page changes', async () => {
  const controller = new AbortController();
  const result = renderMermaid(source, controller.signal);
  const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
  controller.abort();
  await rejection;
  expect(document.querySelector('iframe')).toBeNull();
});

it('cancels queued renders before loading another local renderer', async () => {
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = renderMermaid(source, firstController.signal).catch(() => undefined);
  const second = renderMermaid(source, secondController.signal);
  const rejection = expect(second).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
  secondController.abort();
  firstController.abort();
  await Promise.all([first, rejection]);
  expect(document.querySelector('iframe')).toBeNull();
});

it('reports invalid source without creating a renderer document', async () => {
  await expect(renderMermaid('pie\n "A": 3', new AbortController().signal)).rejects.toThrow('首版');
  expect(document.querySelector('iframe')).toBeNull();
});
