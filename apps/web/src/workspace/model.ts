import type { EditorSnapshot } from '../editor/types';

export interface Page {
  id: string;
  title: string;
  parentId: string | null;
  markdown: string;
  snapshot?: EditorSnapshot;
  originalMarkdown?: string;
  starred: boolean;
  deleted: boolean;
  deletionRoot?: string;
  dirty: boolean;
}
export type Collection = 'overview' | 'recent' | 'favorites' | 'trash';
export interface Workspace { pages: Page[]; currentId: string | null; view: 'document' | Collection; recent: string[]; }
export type Action =
  | { type: 'open'; id: string }
  | { type: 'view'; view: Collection }
  | { type: 'create'; page: Page }
  | { type: 'rename'; id: string; title: string }
  | { type: 'star'; id: string }
  | { type: 'move'; id: string; parentId: string | null }
  | { type: 'delete' | 'restore'; id: string }
  | { type: 'snapshot'; id: string; snapshot: EditorSnapshot; dirty: boolean };

export function descendants(pages: Page[], id: string): Set<string> {
  const ids = new Set([id]);
  let size = 0;
  while (size !== ids.size) { size = ids.size; for (const page of pages) if (page.parentId && ids.has(page.parentId)) ids.add(page.id); }
  return ids;
}
export function canMove(pages: Page[], id: string, parentId: string | null): boolean {
  return pages.some(p => p.id === id && !p.deleted) && (parentId === null || (pages.some(p => p.id === parentId && !p.deleted) && !descendants(pages, id).has(parentId)));
}
export function ancestors(pages: Page[], id: string): Page[] {
  const result: Page[] = []; const visited = new Set([id]);
  let parent = pages.find(p => p.id === id)?.parentId;
  while (parent && !visited.has(parent)) { visited.add(parent); const page = pages.find(p => p.id === parent); if (!page) break; result.unshift(page); parent = page.parentId; }
  return result;
}
export function workspaceReducer(state: Workspace, action: Action): Workspace {
  switch (action.type) {
    case 'open': return state.pages.some(p => p.id === action.id && !p.deleted) ? { ...state, currentId: action.id, view: 'document', recent: [action.id, ...state.recent.filter(id => id !== action.id)] } : state;
    case 'view': return { ...state, view: action.view };
    case 'create': return { ...state, pages: [...state.pages, action.page], currentId: action.page.id, view: 'document', recent: [action.page.id, ...state.recent] };
    case 'rename': return { ...state, pages: state.pages.map(p => p.id === action.id && p.title !== action.title ? { ...p, title: action.title, dirty: true } : p) };
    case 'star': return { ...state, pages: state.pages.map(p => p.id === action.id ? { ...p, starred: !p.starred, dirty: true } : p) };
    case 'snapshot': return { ...state, pages: state.pages.map(p => p.id === action.id ? { ...p, snapshot: action.snapshot, dirty: p.dirty || action.dirty } : p) };
    case 'move': return canMove(state.pages, action.id, action.parentId) ? { ...state, pages: state.pages.map(p => p.id === action.id ? { ...p, parentId: action.parentId, dirty: true } : p) } : state;
    case 'delete': {
      const affected = descendants(state.pages, action.id);
      return { ...state, view: state.currentId && affected.has(state.currentId) ? 'trash' : state.view, pages: state.pages.map(p => affected.has(p.id) && !p.deleted ? { ...p, deleted: true, deletionRoot: action.id, dirty: true } : p) };
    }
    case 'restore': {
      const page = state.pages.find(p => p.id === action.id && p.deleted); if (!page) return state;
      const affected = new Set(state.pages.filter(p => p.deletionRoot === page.deletionRoot && descendants(state.pages, action.id).has(p.id)).map(p => p.id));
      return { ...state, pages: state.pages.map(p => affected.has(p.id) ? { ...p, deleted: false, dirty: true, parentId: p.parentId && state.pages.some(parent => parent.id === p.parentId && parent.deleted && !affected.has(parent.id)) ? null : p.parentId } : p) };
    }
  }
}
