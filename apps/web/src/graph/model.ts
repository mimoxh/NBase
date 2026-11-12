import type { GraphNode, WorkspaceGraphResponse } from '@nbase/contracts';

/** Both workspaces feed the view through this; the view never knows where the graph came from. */
export interface GraphSource {
  load(signal?: AbortSignal): Promise<WorkspaceGraphResponse>;
}

export type GraphColorMode = 'none' | 'group' | 'tag';

export interface GraphFilters {
  /** Case-insensitive title substring; blank keeps everything. */
  query: string;
  /** Keep pages without any visible connection. Ignored in local mode. */
  showOrphans: boolean;
  /** Add parent → child edges derived from `parentId`. */
  showTree: boolean;
  /** Local mode: only pages within `depth` steps of this page. */
  focusId: string | null;
  depth: number;
}

export interface ViewNode extends GraphNode {
  /** Distinct visible neighbours. */
  degree: number;
  /** Saved links in the whole graph, independent of filters. */
  outgoing: number;
  incoming: number;
  /** Id of the top-level ancestor (the node itself for roots). */
  group: string;
  /** Title of that top-level page, which may itself be filtered out of the view. */
  groupTitle: string;
  /** Steps from the focus in local mode, otherwise 0. */
  distance: number;
}

export interface ViewLink {
  source: number;
  target: number;
  kind: 'link' | 'tree';
  /** References source → target and target → source; a tree edge is 1 / 0. */
  forward: number;
  backward: number;
}

export interface GraphView {
  nodes: ViewNode[];
  links: ViewLink[];
  index: Map<string, number>;
  /** Visible neighbour indexes per node. */
  neighbors: number[][];
}

export const graphDepthLimit = 3;
const untitled = '未命名页面';
export const nodeTitle = (node: { title: string }): string => node.title || untitled;

interface Pair { a: string; b: string; kind: 'link' | 'tree'; forward: number; backward: number }

/** Undirected pairs: opposite link directions merge into one edge that remembers both counts. */
function pairs(data: WorkspaceGraphResponse, ids: ReadonlySet<string>, showTree: boolean): Pair[] {
  const merged = new Map<string, Pair>();
  for (const edge of data.edges) {
    if (edge.source === edge.target || !ids.has(edge.source) || !ids.has(edge.target)) continue;
    const flipped = edge.source > edge.target;
    const a = flipped ? edge.target : edge.source, b = flipped ? edge.source : edge.target;
    const key = `${a}\n${b}`;
    const pair = merged.get(key) ?? { a, b, kind: 'link' as const, forward: 0, backward: 0 };
    // Every link kind adds to the same pair; a per-kind split would start here.
    if (flipped) pair.backward += edge.count; else pair.forward += edge.count;
    merged.set(key, pair);
  }
  const result = [...merged.values()];
  if (showTree) for (const node of data.nodes) {
    if (node.parentId && node.parentId !== node.id && ids.has(node.parentId)) {
      result.push({ a: node.parentId, b: node.id, kind: 'tree', forward: 1, backward: 0 });
    }
  }
  return result;
}

/** Breadth-first distances from `start` over undirected pairs, up to `depth` steps. */
export function neighborhood(adjacency: ReadonlyMap<string, readonly string[]>, start: string, depth: number): Map<string, number> {
  const distance = new Map<string, number>([[start, 0]]);
  let frontier = [start];
  for (let step = 1; step <= depth && frontier.length; step++) {
    const next: string[] = [];
    for (const id of frontier) for (const other of adjacency.get(id) ?? []) {
      if (!distance.has(other)) { distance.set(other, step); next.push(other); }
    }
    frontier = next;
  }
  return distance;
}

function topLevel(byId: ReadonlyMap<string, GraphNode>, node: GraphNode): string {
  const seen = new Set([node.id]);
  let current = node;
  while (current.parentId) {
    const parent = byId.get(current.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id); current = parent;
  }
  return current.id;
}

export function buildGraphView(data: WorkspaceGraphResponse, filters: GraphFilters): GraphView {
  const byId = new Map(data.nodes.map(node => [node.id, node]));
  const all = pairs(data, new Set(byId.keys()), filters.showTree);
  const adjacency = new Map<string, string[]>();
  const connect = (from: string, to: string) => { const list = adjacency.get(from); if (list) list.push(to); else adjacency.set(from, [to]); };
  for (const pair of all) { connect(pair.a, pair.b); connect(pair.b, pair.a); }

  const focus = filters.focusId && byId.has(filters.focusId) ? filters.focusId : null;
  const reach = focus ? neighborhood(adjacency, focus, Math.max(1, Math.min(graphDepthLimit, Math.round(filters.depth)))) : null;
  const query = filters.query.trim().toLocaleLowerCase();
  const kept = data.nodes.filter(node => {
    if (reach) { if (!reach.has(node.id)) return false; }
    else if (!filters.showOrphans && !adjacency.has(node.id)) return false;
    return node.id === focus || !query || nodeTitle(node).toLocaleLowerCase().includes(query);
  });

  const outgoing = new Map<string, number>(), incoming = new Map<string, number>();
  for (const edge of data.edges) {
    if (edge.source === edge.target || !byId.has(edge.source) || !byId.has(edge.target)) continue;
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }
  const index = new Map(kept.map((node, position) => [node.id, position]));
  const nodes: ViewNode[] = kept.map(node => ({ ...node, degree: 0, outgoing: outgoing.get(node.id) ?? 0,
    incoming: incoming.get(node.id) ?? 0, group: topLevel(byId, node), groupTitle: nodeTitle(byId.get(topLevel(byId, node))!), distance: reach?.get(node.id) ?? 0 }));
  const neighborSets = nodes.map(() => new Set<number>());
  const links: ViewLink[] = [];
  for (const pair of all) {
    const source = index.get(pair.a), target = index.get(pair.b);
    if (source === undefined || target === undefined) continue;
    links.push({ source, target, kind: pair.kind, forward: pair.forward, backward: pair.backward });
    neighborSets[source]!.add(target); neighborSets[target]!.add(source);
  }
  const neighbors = neighborSets.map(set => [...set]);
  nodes.forEach((node, position) => { node.degree = neighbors[position]!.length; });
  return { nodes, links, index, neighbors };
}

export interface LinkedPage { id: string; title: string; icon: string | null; count: number }

/** Saved links of one page from the unfiltered graph, for the keyboard list beside the canvas. */
export function linkLists(data: WorkspaceGraphResponse, id: string): { outgoing: LinkedPage[]; incoming: LinkedPage[] } {
  const byId = new Map(data.nodes.map(node => [node.id, node]));
  const collect = (own: 'source' | 'target', other: 'source' | 'target') => {
    const totals = new Map<string, number>();
    for (const edge of data.edges) {
      if (edge[own] !== id || edge[other] === id || !byId.has(edge[other])) continue;
      totals.set(edge[other], (totals.get(edge[other]) ?? 0) + edge.count);
    }
    return [...totals].map(([pageId, count]): LinkedPage => {
      const node = byId.get(pageId)!;
      return { id: pageId, title: nodeTitle(node), icon: node.icon, count };
    }).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'zh-Hans-CN') || a.id.localeCompare(b.id));
  };
  return { outgoing: collect('source', 'target'), incoming: collect('target', 'source') };
}

export const graphPalette = ['#3e63dd', '#d9730d', '#2f9e6b', '#c2417c', '#8b5cf6', '#0e9aa7', '#b08a1e', '#d1493f'] as const;

function slot(key: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { value ^= key.charCodeAt(i); value = Math.imul(value, 0x01000193); }
  return (value >>> 0) % graphPalette.length;
}

/** Palette colour for a node, or null for the neutral theme colour. Stable per group or tag id. */
export function nodeColor(node: ViewNode, mode: GraphColorMode): string | null {
  if (mode === 'group') return graphPalette[slot(node.group)]!;
  if (mode === 'tag') return node.tagIds.length ? graphPalette[slot(node.tagIds[0]!)]! : null;
  return null;
}

/** Legend entries for the colours in use, largest groups first. */
export function colorLegend(view: GraphView, mode: GraphColorMode, tagNames: ReadonlyMap<string, string>,
  limit = 8): { key: string; label: string; color: string; count: number }[] {
  if (mode === 'none') return [];
  const titles = new Map(view.nodes.map(node => [node.group, node.groupTitle]));
  const counts = new Map<string, number>();
  for (const node of view.nodes) {
    const key = mode === 'group' ? node.group : node.tagIds[0];
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([key, count]) => ({
    key, count, color: graphPalette[slot(key)]!,
    label: mode === 'group' ? titles.get(key) ?? '其他页面' : tagNames.get(key) ?? '标签',
  }));
}

export const nodeRadius = (degree: number): number => Math.min(18, 3.5 + Math.sqrt(degree) * 1.9);

/** Smallest zoom at which a node shows its label: hubs first, everything from about 1.15×. */
export const labelZoom = (degree: number): number => Math.max(0.28, 1.15 - Math.sqrt(degree) * 0.2);

export function truncateLabel(text: string, limit = 22): string {
  const chars = [...text];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : text;
}
