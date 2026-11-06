import type { PageSummary } from '@nbase/contracts';

export function subtreeIds(pages: readonly PageSummary[], rootId: string): string[] {
  const ids = new Set([rootId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const page of pages) if (page.parentId && ids.has(page.parentId) && !ids.has(page.id)) {
      ids.add(page.id); changed = true;
    }
  }
  return [...ids];
}

/** Root-first ancestors; a broken or cyclic parent link ends the chain instead of looping. */
export function ancestorChain(pages: readonly PageSummary[], parentId: string | null): PageSummary[] {
  const chain: PageSummary[] = [];
  let cursor = parentId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = pages.find(page => page.id === cursor);
    if (!parent) break;
    chain.unshift(parent);
    cursor = parent.parentId;
  }
  return chain;
}

export function ancestorPath(pages: readonly PageSummary[], pageId: string): string {
  const parentId = pages.find(page => page.id === pageId)?.parentId ?? null;
  return ancestorChain(pages, parentId).map(page => page.title || '未命名页面').join(' / ') || '个人空间';
}
