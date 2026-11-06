import type { OutlineItem } from '../editor/types';

/** B-direction dash rail: fixed, vertically centered, clear of the scrollbar. */
export function Toc({ outline, onJump }: { outline: OutlineItem[]; onJump: (id: string) => void }) {
  if (!outline.length) return null;
  return <nav className="nb-toc" aria-label="页面大纲">
    {outline.map(item => <button key={item.id} className={`nb-toc-dash nb-toc-l${Math.min(item.level, 3)}`}
      aria-label={item.text} onClick={() => onJump(item.id)}><i /> <span>{item.text}</span></button>)}
  </nav>;
}
