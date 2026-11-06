import type { PageSummary } from '@nbase/contracts';

export interface PageReferenceCandidate {
  id: string;
  title: string;
  parentPath: string;
}

export interface PageReferenceCatalog {
  activeIds: ReadonlySet<string>;
  byExactTitle: ReadonlyMap<string, string | null>;
  candidates: readonly PageReferenceCandidate[];
}

export function exactReferenceTitle(title: string): string {
  return title.normalize('NFC').trim();
}

export function buildPageReferenceCatalog(pages: readonly PageSummary[]): PageReferenceCatalog {
  const byId = new Map(pages.map(page => [page.id, page]));
  const paths = new Map<string, string>();
  function pathTo(id: string | null, seen = new Set<string>()): string {
    if (!id || seen.has(id) || seen.size >= 64) return '';
    const cached = paths.get(id);
    if (cached !== undefined) return cached;
    const page = byId.get(id);
    if (!page) return '';
    seen.add(id);
    const parent = pathTo(page.parentId, seen);
    const name = page.title.trim() || '未命名页面';
    const path = parent ? parent + ' / ' + name : name;
    paths.set(id, path);
    return path;
  }

  const byExactTitle = new Map<string, string | null>();
  const candidates = pages.map(page => {
    const exact = exactReferenceTitle(page.title);
    if (exact) byExactTitle.set(exact, byExactTitle.has(exact) ? null : page.id);
    return { id: page.id, title: page.title.trim() || '未命名页面', parentPath: pathTo(page.parentId) || '工作区根目录' };
  });
  return { activeIds: new Set(byId.keys()), byExactTitle, candidates };
}

export function searchPageReferences(catalog: PageReferenceCatalog, input: string): PageReferenceCandidate[] {
  const query = exactReferenceTitle(input).toLowerCase();
  if (!query) return catalog.candidates.slice(0, 12);
  return catalog.candidates.flatMap(candidate => {
    const title = exactReferenceTitle(candidate.title).toLowerCase();
    const parent = exactReferenceTitle(candidate.parentPath).toLowerCase();
    const rank = title === query ? 0 : title.startsWith(query) ? 1 : title.includes(query) ? 2
      : (parent + ' / ' + title).includes(query) ? 3 : -1;
    return rank < 0 ? [] : [{ candidate, rank }];
  }).sort((a, b) => a.rank - b.rank).slice(0, 12).map(item => item.candidate);
}
