import rendererAsset from 'mermaid/dist/mermaid.min.js?url';
import { mermaidSourceProblem } from './mermaidSource';

const maxSvgLength = 512 * 1024;
const renderTimeoutMs = 12_000;
let renderQueue: Promise<unknown> = Promise.resolve();

function frameDocument(asset: URL): string {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const frame = document.implementation.createHTMLDocument();
  const policy = frame.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = `default-src 'none'; script-src 'nonce-${nonce}' ${asset.origin}${asset.pathname}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
  frame.head.append(policy);
  const library = frame.createElement('script');
  library.src = asset.href;
  frame.head.append(library);
  const diagram = frame.createElement('div');
  diagram.id = 'diagram';
  frame.body.append(diagram);

  // This program is trusted and the diagram source arrives by message, never as HTML.
  const script = frame.createElement('script');
  script.setAttribute('nonce', nonce);
  script.textContent = `
    const parentOrigin = ${JSON.stringify(location.origin)};
    let started = false;
    addEventListener('message', async event => {
      if (started || event.origin !== parentOrigin || event.source !== parent ||
          event.data?.type !== 'nbase-mermaid-render' || typeof event.data.source !== 'string') return;
      started = true;
      try {
        if (!globalThis.mermaid) throw new Error('无法加载本地图表渲染器。');
        mermaid.initialize({
          startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
          suppressErrorRendering: true, maxTextSize: 12288, maxEdges: 80,
          theme: 'neutral', fontFamily: 'sans-serif'
        });
        const {svg, diagramType} = await mermaid.render('nbase-diagram', event.data.source, document.getElementById('diagram'));
        if (diagramType !== 'flowchart-v2' && diagramType !== 'flowchart' && diagramType !== 'sequence') {
          throw new Error('首版支持流程图和时序图。');
        }
        parent.postMessage({type: 'nbase-mermaid-result', svg}, parentOrigin);
      } catch (failure) {
        const reason = String(failure?.message || failure).slice(0, 300);
        parent.postMessage({type: 'nbase-mermaid-error', reason}, parentOrigin);
      }
    });
    parent.postMessage({type: 'nbase-mermaid-ready'}, parentOrigin);
  `;
  frame.body.append(script);
  return '<!doctype html>' + frame.documentElement.outerHTML;
}

function renderInFrame(source: string, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const asset = new URL(rendererAsset, location.href);
  if (asset.origin !== location.origin) throw new Error('本地图表渲染器地址无效。');
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.className = 'nbase-mermaid-render-frame';
  frame.srcdoc = frameDocument(asset);
  return new Promise((resolve, reject) => {
    function cleanUp() {
      window.clearTimeout(timeout);
      window.removeEventListener('message', message);
      signal.removeEventListener('abort', cancel);
      frame.remove();
    }
    function cancel() { cleanUp(); reject(signal.reason); }
    function message(event: MessageEvent) {
      if (event.source !== frame.contentWindow || event.origin !== 'null') return;
      const { type, svg, reason } = event.data ?? {};
      if (type === 'nbase-mermaid-ready') {
        // Opaque sandbox origins require a wildcard destination. The window
        // object above identifies this specific iframe.
        frame.contentWindow?.postMessage({ type: 'nbase-mermaid-render', source }, '*');
      } else if (type === 'nbase-mermaid-error') {
        cleanUp();
        reject(new Error(typeof reason === 'string' ? reason : '图表解析失败。'));
      } else if (type === 'nbase-mermaid-result') {
        cleanUp();
        if (typeof svg !== 'string' || !svg.startsWith('<svg') || svg.length > maxSvgLength
          || /<(?:script|foreignobject|iframe|image|a)\b|\son[a-z]+\s*=|\shref\s*=\s*["'](?!#)/iu.test(svg)) {
          reject(new Error('图表输出包含不支持的内容或超出大小限制。'));
          return;
        }
        resolve(new Blob([svg], { type: 'image/svg+xml' }));
      }
    }
    const timeout = window.setTimeout(() => {
      cleanUp();
      reject(new Error('图表预览超时。'));
    }, renderTimeoutMs);
    window.addEventListener('message', message);
    signal.addEventListener('abort', cancel, { once: true });
    document.body.append(frame);
  });
}

export async function renderMermaid(source: string, signal: AbortSignal): Promise<Blob> {
  const problem = mermaidSourceProblem(source);
  if (problem) throw new Error(problem);
  const task = renderQueue.then(() => renderInFrame(source, signal));
  renderQueue = task.catch(() => undefined);
  return task;
}
