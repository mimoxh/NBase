import { useEffect, useMemo, useState } from 'react';
import { mermaidSourceProblem } from './mermaidSource';
import './mermaid.css';

type Preview = { source: string; url: string } | { source: string; error: string };

export function MermaidCopyButton({ source }: { source: string }) {
  const [notice, setNotice] = useState('');
  return <>
    <button type="button" className="nb-btn" onClick={async () => {
      try {
        await navigator.clipboard.writeText(source);
        setNotice('已复制图表源码。');
      } catch {
        setNotice('请选中图表源码后手动复制。');
      }
    }}>复制源码</button>
    {notice && <small role="status">{notice}</small>}
  </>;
}

export function MermaidPreview({ source, requested }: { source: string; requested: boolean }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const problem = useMemo(() => mermaidSourceProblem(source), [source]);
  useEffect(() => {
    if (!requested || problem) return;
    const controller = new AbortController();
    let url: string | undefined;
    setPreview(null);
    void import('./renderMermaid').then(({ renderMermaid }) => renderMermaid(source, controller.signal)).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setPreview({ source, url });
    }).catch(reason => {
      if (!controller.signal.aborted) setPreview({ source, error: reason instanceof Error ? reason.message : '图表预览失败。' });
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [problem, requested, source]);

  const result = preview?.source === source ? preview : null;
  const error = problem ?? (requested && result && 'error' in result ? result.error : null);
  if (error) return <div className="nbase-mermaid-fallback">
    <p role="status">{error}</p><pre>{source}</pre>
  </div>;
  if (!requested) return null;
  if (!result || !('url' in result)) return <p role="status">正在生成图表预览…</p>;
  return <img className="nbase-mermaid-image" src={result.url} alt="Mermaid 图表" onError={() => setPreview({ source, error: '图表图片无法显示，可复制源码后重试。' })} />;
}
