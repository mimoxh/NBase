import { graphEdgeLimit, graphNodeLimit, type GraphEdge, type GraphNode, type WorkspaceGraphResponse } from '@nbase/contracts';
import type { GraphSource } from './model';

/** The slice of a demo page the graph needs; `workspace/model.ts` pages satisfy it structurally. */
export interface DemoGraphPage {
  id: string;
  title: string;
  parentId: string | null;
  icon: string | null;
  deleted: boolean;
  kind?: 'document' | 'database' | 'row' | 'whiteboard';
  snapshot?: { content: { editorState: { root: unknown } } };
}

function referencedIds(value: unknown, out: string[], depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 64) return;
  const node = value as { type?: unknown; targetPageId?: unknown; children?: unknown };
  if (node.type === 'page-reference' && typeof node.targetPageId === 'string') out.push(node.targetPageId);
  if (Array.isArray(node.children)) for (const child of node.children) referencedIds(child, out, depth + 1);
}

/** Mirrors the server rules on in-memory pages: active pages only, rows folded into their database. */
export function demoGraph(pages: readonly DemoGraphPage[]): WorkspaceGraphResponse {
  const active = new Map(pages.filter(page => !page.deleted).map(page => [page.id, page]));
  const fold = (id: string): string | null => {
    const page = active.get(id);
    if (!page) return null;
    return page.kind === 'row' ? (page.parentId && active.has(page.parentId) ? page.parentId : null) : page.id;
  };
  const visible = [...active.values()].filter(page => page.kind !== 'row');
  const nodes: GraphNode[] = visible.slice(0, graphNodeLimit).map(page => ({ id: page.id, title: page.title, icon: page.icon,
    kind: page.kind === 'database' || page.kind === 'whiteboard' ? page.kind : 'document', parentId: null, tagIds: [] }));
  const ids = new Set(nodes.map(node => node.id));
  for (const node of nodes) {
    const parent = active.get(node.id)!.parentId;
    const folded = parent ? fold(parent) : null;
    node.parentId = folded && folded !== node.id && ids.has(folded) ? folded : null;
  }
  const counts = new Map<string, GraphEdge>();
  for (const page of active.values()) {
    const source = fold(page.id);
    if (!source || !ids.has(source) || !page.snapshot) continue;
    const targets: string[] = [];
    referencedIds(page.snapshot.content.editorState.root, targets);
    for (const raw of targets) {
      const target = fold(raw);
      if (!target || target === source || !ids.has(target)) continue;
      const key = `${source}\n${target}`;
      const edge = counts.get(key);
      if (edge) edge.count++; else counts.set(key, { source, target, kind: 'page-reference', count: 1 });
    }
  }
  const edges = [...counts.values()].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  return { nodes, edges: edges.slice(0, graphEdgeLimit), truncated: visible.length > graphNodeLimit || edges.length > graphEdgeLimit };
}

/** Reads the latest pages on every load, so reopening the graph reflects the current session. */
export function createDemoGraphSource(pages: () => readonly DemoGraphPage[]): GraphSource {
  return { load: async () => demoGraph(pages()) };
}
