import { applyRowPatch, type DatabaseView, type PageCoverId, type PageKind, type PropertyDefinition,
  type PropertyValue, type RowProperties, type WhiteboardContent } from '@nbase/contracts';
import type { EditorSnapshot } from '../editor/types';
import { placePage, type PagePlacement } from '../shell/pageOrder';

export interface Page {
  id: string;
  title: string;
  parentId: string | null;
  markdown: string;
  snapshot?: EditorSnapshot;
  originalMarkdown?: string;
  icon: string | null;
  cover: PageCoverId | null;
  starred: boolean;
  deleted: boolean;
  deletionRoot?: string;
  dirty: boolean;
  /** Missing means a document. */
  kind?: PageKind;
  /** Database pages only. */
  database?: { properties: PropertyDefinition[]; views: DatabaseView[]; revision: number };
  /** Row pages only. */
  properties?: RowProperties;
  /** Whiteboard pages only. */
  board?: WhiteboardContent;
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
}
export type Collection = 'overview' | 'recent' | 'favorites' | 'trash';
export interface Workspace { pages: Page[]; currentId: string | null; view: 'document' | Collection; recent: string[]; }
export type Action =
  | { type: 'open'; id: string }
  | { type: 'view'; view: Collection }
  | { type: 'create'; page: Page }
  | { type: 'rename'; id: string; title: string }
  | { type: 'star'; id: string }
  | { type: 'icon'; id: string; icon: string | null }
  | { type: 'cover'; id: string; cover: PageCoverId | null }
  | { type: 'move'; id: string; parentId: string | null }
  | { type: 'place'; id: string; placement: PagePlacement }
  | { type: 'delete' | 'restore'; id: string }
  | { type: 'snapshot'; id: string; snapshot: EditorSnapshot; dirty: boolean }
  | { type: 'insert'; page: Page }
  | { type: 'db-schema'; id: string; properties: PropertyDefinition[]; views: DatabaseView[] }
  | { type: 'board'; id: string; content: WhiteboardContent }
  | { type: 'row-update'; id: string; title?: string; properties?: Record<string, PropertyValue | null>; at: string };

export function descendants(pages: Page[], id: string): Set<string> {
  const ids = new Set([id]);
  let size = 0;
  while (size !== ids.size) { size = ids.size; for (const page of pages) if (page.parentId && ids.has(page.parentId)) ids.add(page.id); }
  return ids;
}
/** Rows stay in their database, and only documents can hold child pages. */
export function canMove(pages: Page[], id: string, parentId: string | null): boolean {
  const page = pages.find(p => p.id === id && !p.deleted);
  if (!page || page.kind === 'row') return false;
  if (parentId === null) return true;
  const parent = pages.find(p => p.id === parentId && !p.deleted);
  return Boolean(parent) && (parent!.kind ?? 'document') === 'document' && !descendants(pages, id).has(parentId);
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
    case 'icon': return { ...state, pages: state.pages.map(p => p.id === action.id ? { ...p, icon: action.icon, dirty: true } : p) };
    case 'cover': return { ...state, pages: state.pages.map(p => p.id === action.id ? { ...p, cover: action.cover, dirty: true } : p) };
    case 'snapshot': return { ...state, pages: state.pages.map(p => p.id === action.id ? { ...p, snapshot: action.snapshot, dirty: p.dirty || action.dirty } : p) };
    case 'place': return canMove(state.pages, action.id, action.placement.parentId)
      || state.pages.some(p => p.id === action.id && p.kind === 'row' && !p.deleted && p.parentId === action.placement.parentId)
      ? { ...state, pages: placePage(state.pages, action.id, action.placement) } : state;
    case 'move': return canMove(state.pages, action.id, action.parentId) ? { ...state, pages: state.pages.map(p => p.id === action.id ? { ...p, parentId: action.parentId, dirty: true } : p) } : state;
    case 'delete': {
      const affected = descendants(state.pages, action.id);
      return { ...state, view: state.currentId && affected.has(state.currentId) ? 'trash' : state.view, pages: state.pages.map(p => affected.has(p.id) && !p.deleted ? { ...p, deleted: true, deletionRoot: action.id, dirty: true } : p) };
    }
    case 'insert': return { ...state, pages: [...state.pages, action.page] };
    case 'board': return { ...state, pages: state.pages.map(p => p.id === action.id && p.kind === 'whiteboard' ? { ...p, board: action.content, dirty: true } : p) };
    case 'db-schema': return { ...state, pages: state.pages.map(p => p.id === action.id && p.database
      ? { ...p, database: { properties: action.properties, views: action.views, revision: p.database.revision + 1 }, dirty: true } : p) };
    case 'row-update': return { ...state, pages: state.pages.map(p => p.id !== action.id ? p : {
      ...p, ...(action.title !== undefined ? { title: action.title } : {}),
      ...(action.properties ? { properties: applyRowPatch(p.properties ?? {}, action.properties) } : {}),
      revision: (p.revision ?? 1) + 1, updatedAt: action.at, dirty: true }) };
    case 'restore': {
      const page = state.pages.find(p => p.id === action.id && p.deleted); if (!page) return state;
      // A row needs its database back first.
      if (page.kind === 'row' && state.pages.some(p => p.id === page.parentId && p.deleted)) return state;
      const affected = new Set(state.pages.filter(p => p.deletionRoot === page.deletionRoot && descendants(state.pages, action.id).has(p.id)).map(p => p.id));
      return { ...state, pages: state.pages.map(p => affected.has(p.id) ? { ...p, deleted: false, dirty: true, parentId: p.parentId && state.pages.some(parent => parent.id === p.parentId && parent.deleted && !affected.has(parent.id)) ? null : p.parentId } : p) };
    }
  }
}
