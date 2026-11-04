import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { pillLabels, type SaveStatus } from './saveTone';

/** Save-state pill; full text and retry/download actions live in its popover.
 *  `demo` forces the neutral "unsaved demo" label — the pill must never claim 已保存 without a server. */
export function SavePill({ status, hasDraft, onRetry, onDownload, demo = false }: {
  status: SaveStatus; hasDraft: boolean; onRetry: () => void; onDownload: () => void; demo?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key, true); };
  }, [open]);
  const tone = demo ? 'idle' : status.tone;
  const label = demo ? '演示 · 未保存' : tone === 'idle' ? '已保存' : pillLabels[tone];
  return <div className="nb-savepill-wrap" ref={rootRef}>
    <button className={`nb-savepill nb-save-${tone}`} role="status" aria-expanded={open}
      aria-label={`保存状态：${label}`} onClick={() => setOpen(!open)}>
      <span className={`nb-save-dot ${tone === 'saving' ? 'nb-save-spin' : ''}`}>
        {tone === 'saved' && <Icon name="check" size={11} />}
        {tone === 'saving' && <Icon name="clock" size={11} />}
      </span>{label}
    </button>
    {open && <div className="nb-savepop" role="dialog" aria-label="保存详情">
      <p>{demo ? '演示模式的内容只保留在当前会话。' : status.text || '页面内容以服务端确认为准'}</p>
      {!demo && hasDraft && <button className="nb-btn nb-btn-quiet" onClick={() => { setOpen(false); onRetry(); }}>立即重试保存</button>}
      <button className="nb-btn nb-btn-quiet" onClick={() => { setOpen(false); onDownload(); }}>下载当前内容</button>
    </div>}
  </div>;
}
