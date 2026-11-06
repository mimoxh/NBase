const maxRenderBytes = 12 * 1024;
const maxStatements = 128;
const maxConnections = 80;

export const defaultMermaidSource = 'flowchart TD\n  A[开始] --> B[完成]';

/** Only send a bounded subset of Mermaid source to the renderer. */
export function mermaidSourceProblem(source: string): string | null {
  if (!source.trim()) return '请输入流程图或时序图源码。';
  if (source.length > maxRenderBytes || new TextEncoder().encode(source).length > maxRenderBytes
    || source.split(/[\r\n;]/).length > maxStatements
    || (source.match(/[-=.~]{2,}|&/g)?.length ?? 0) > maxConnections) {
    return '图表超过预览限制，可复制源码后分成较小的图表。';
  }
  if (/%%\s*\{|@\{|<\/?[a-z!]|\burl\s*\(|@import\b|https?:\/\/|(?:^|[\r\n;])\s*(?:click|links?|linkStyle|classDef|style|properties)\s/iu.test(source)) {
    return '图表含配置指令、交互、样式或外部资源，可复制源码后调整。';
  }
  const firstLine = source.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('%%')) ?? '';
  if (!/^(?:flowchart|graph|sequenceDiagram)(?:[ \t;]|$)/.test(firstLine)) return '首版支持流程图和时序图。';
  return null;
}

export const mermaidFenceStart = /^ {0,3}(`{3,})[ \t]*mermaid[ \t]*$/i;

export function fencedMermaidSource(source: string): string {
  let length = 3;
  for (const run of source.matchAll(/`{3,}/g)) length = Math.max(length, run[0].length + 1);
  const fence = '`'.repeat(length);
  return fence + 'mermaid\n' + (source ? source + '\n' : '') + fence;
}
