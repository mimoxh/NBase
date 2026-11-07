type TreeItem = { id: string; parentId: string | null };

/** Where a page lands: under `parentId`, right after `afterId`, or first when `afterId` is null. */
export interface PagePlacement { parentId: string | null; afterId: string | null }

/** True when `id` is `candidate` or one of its ancestors, so dropping there would make a cycle. */
export function isSelfOrAncestor(pages: readonly TreeItem[], id: string, candidate: string | null): boolean {
  const byId = new Map(pages.map(page => [page.id, page]));
  for (let current = candidate; current; current = byId.get(current)?.parentId ?? null) {
    if (current === id) return true;
  }
  return false;
}

/** The array keeps sibling order, so a move is a splice; `parentId` changes with it. */
export function placePage<T extends TreeItem>(pages: readonly T[], id: string, { parentId, afterId }: PagePlacement): T[] {
  const page = pages.find(item => item.id === id);
  if (!page) return [...pages];
  const rest = pages.filter(item => item.id !== id);
  const moved = page.parentId === parentId ? page : { ...page, parentId };
  const anchor = afterId === null ? -1 : rest.findIndex(item => item.id === afterId);
  const firstSibling = rest.findIndex(item => item.parentId === parentId);
  const index = anchor >= 0 ? anchor + 1 : firstSibling >= 0 ? firstSibling : rest.length;
  return [...rest.slice(0, index), moved, ...rest.slice(index)];
}

/** The placement that moves a page one step among its siblings, or null at either end. */
export function siblingStep(pages: readonly TreeItem[], id: string, direction: -1 | 1): PagePlacement | null {
  const page = pages.find(item => item.id === id);
  if (!page) return null;
  const siblings = pages.filter(item => item.parentId === page.parentId);
  const index = siblings.findIndex(item => item.id === id);
  const target = index + direction;
  if (target < 0 || target >= siblings.length) return null;
  const afterIndex = direction < 0 ? target - 1 : target;
  return { parentId: page.parentId, afterId: siblings[afterIndex]?.id ?? null };
}
