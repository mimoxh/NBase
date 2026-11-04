import type { OutlineItem } from '../editor/types';

/** B-direction dash rail: fixed, vertically centered, clear of the scrollbar. */
export function Toc({ outline }: { outline: OutlineItem[] }) {
  if (!outline.length) return null;
  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return <nav className="nb-toc" aria-label="页面大纲">
    {outline.map(item => <button key={item.id} className={`nb-toc-dash nb-toc-l${Math.min(item.level, 3)}`}
      aria-label={item.text} onClick={() => jump(item.id)}><i /> <span>{item.text}</span></button>)}
  </nav>;
}
