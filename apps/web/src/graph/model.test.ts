import type { GraphEdge, GraphNode, WorkspaceGraphResponse } from '@nbase/contracts';
import { expect, it } from 'vitest';
import { demoGraph, type DemoGraphPage } from './demoSource';
import { buildGraphView, colorLegend, labelZoom, linkLists, neighborhood, nodeColor, nodeRadius, truncateLabel, type GraphFilters } from './model';

const node = (id: string, parentId: string | null = null, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, title: id.toUpperCase(), icon: null, kind: 'document', parentId, tagIds: [], ...extra });
const edge = (source: string, target: string, count = 1): GraphEdge => ({ source, target, kind: 'page-reference', count });
const all: GraphFilters = { query: '', showOrphans: true, showTree: false, focusId: null, depth: 1 };
// a ⇄ b → c → d, e under a (tree only), f alone.
const data: WorkspaceGraphResponse = { truncated: false,
  nodes: [node('a'), node('b', 'a'), node('c'), node('d', 'c', { tagIds: ['t1'] }), node('e', 'a'), node('f')],
  edges: [edge('a', 'b', 2), edge('b', 'a'), edge('b', 'c'), edge('c', 'd', 3), edge('a', 'ghost'), edge('c', 'c')] };
const titles = (view: { nodes: { id: string }[] }) => view.nodes.map(item => item.id).join('');

it('merges both directions into one edge and counts visible neighbours', () => {
  const view = buildGraphView(data, all);
  expect(titles(view)).toBe('abcdef');
  expect(view.links).toEqual([
    { source: 0, target: 1, kind: 'link', forward: 2, backward: 1 },
    { source: 1, target: 2, kind: 'link', forward: 1, backward: 0 },
    { source: 2, target: 3, kind: 'link', forward: 3, backward: 0 },
  ]);
  expect(view.nodes.map(item => item.degree)).toEqual([1, 2, 2, 1, 0, 0]);
  expect(view.nodes.map(item => [item.outgoing, item.incoming])).toEqual([[1, 1], [2, 1], [1, 1], [0, 1], [0, 0], [0, 0]]);
  expect(view.neighbors[1]!.sort()).toEqual([0, 2]);
  expect(view.nodes.map(item => item.group)).toEqual(['a', 'a', 'c', 'c', 'a', 'f']);
});

it('hides orphans on request and treats hierarchy edges as connections when shown', () => {
  expect(titles(buildGraphView(data, { ...all, showOrphans: false }))).toBe('abcd');
  const tree = buildGraphView(data, { ...all, showOrphans: false, showTree: true });
  expect(titles(tree)).toBe('abcde');
  expect(tree.links.filter(item => item.kind === 'tree').map(item => [item.source, item.target])).toEqual([[0, 1], [2, 3], [0, 4]]);
  expect(tree.nodes[0]!.degree).toBe(2);
});

it('filters by title without case and keeps only edges between matches', () => {
  const view = buildGraphView({ ...data, nodes: data.nodes.map(item => item.id === 'c' ? { ...item, title: '项目 Alpha' } : item) },
    { ...all, query: ' alpha ' });
  expect(titles(view)).toBe('c');
  expect(view.links).toEqual([]);
  expect(titles(buildGraphView({ ...data, nodes: [node('x', null, { title: '' })] , edges: [] }, { ...all, query: '未命名' }))).toBe('x');
});

it('local mode keeps the neighbourhood within the chosen depth', () => {
  const one = buildGraphView(data, { ...all, focusId: 'a', depth: 1 });
  expect(titles(one)).toBe('ab');
  const two = buildGraphView(data, { ...all, focusId: 'a', depth: 2 });
  expect(titles(two)).toBe('abc');
  expect(two.nodes.map(item => item.distance)).toEqual([0, 1, 2]);
  expect(titles(buildGraphView(data, { ...all, focusId: 'a', depth: 99 }))).toBe('abcd');
  expect(titles(buildGraphView(data, { ...all, focusId: 'a', depth: 1, showTree: true }))).toBe('abe');
  // The centre survives a text filter; an unknown centre falls back to the whole graph.
  expect(titles(buildGraphView(data, { ...all, focusId: 'a', depth: 2, query: 'c' }))).toBe('ac');
  expect(titles(buildGraphView(data, { ...all, focusId: 'missing' }))).toBe('abcdef');
  expect(titles(buildGraphView(data, { ...all, focusId: 'f', showOrphans: false }))).toBe('f');
});

it('walks breadth first and tolerates cycles', () => {
  const adjacency = new Map([['a', ['b']], ['b', ['a', 'c']], ['c', ['b', 'a']]]);
  expect([...neighborhood(adjacency, 'a', 1)]).toEqual([['a', 0], ['b', 1]]);
  expect([...neighborhood(adjacency, 'a', 5)]).toEqual([['a', 0], ['b', 1], ['c', 2]]);
  expect([...neighborhood(adjacency, 'zzz', 2)]).toEqual([['zzz', 0]]);
});

it('lists a page\'s outgoing and incoming links from the unfiltered graph', () => {
  const lists = linkLists(data, 'b');
  expect(lists.outgoing.map(item => [item.id, item.count])).toEqual([['a', 1], ['c', 1]]);
  expect(lists.incoming.map(item => [item.id, item.count])).toEqual([['a', 2]]);
  expect(linkLists(data, 'f')).toEqual({ outgoing: [], incoming: [] });
});

it('colours by top-level page or first tag and builds a legend', () => {
  const view = buildGraphView(data, all);
  expect(nodeColor(view.nodes[0]!, 'none')).toBeNull();
  expect(nodeColor(view.nodes[1]!, 'group')).toBe(nodeColor(view.nodes[0]!, 'group'));
  expect(nodeColor(view.nodes[0]!, 'tag')).toBeNull();
  expect(nodeColor(view.nodes[3]!, 'tag')).toMatch(/^#/);
  expect(colorLegend(view, 'group', new Map()).map(item => [item.label, item.count])).toEqual([['A', 3], ['C', 2], ['F', 1]]);
  expect(colorLegend(view, 'tag', new Map([['t1', '重要']])).map(item => [item.label, item.count])).toEqual([['重要', 1]]);
  expect(colorLegend(view, 'none', new Map())).toEqual([]);
});

it('scales nodes and label visibility with degree', () => {
  expect(nodeRadius(16)).toBeGreaterThan(nodeRadius(1));
  expect(nodeRadius(10_000)).toBeLessThanOrEqual(18);
  expect(labelZoom(25)).toBeLessThan(labelZoom(0));
  expect(truncateLabel('一二三四五', 4)).toBe('一二三…');
  expect(truncateLabel('短')).toBe('短');
});

it('derives the demo graph from in-memory pages with the server\'s rules', () => {
  const reference = (targetPageId: string) => ({ type: 'page-reference', version: 1, targetPageId, label: 'x' });
  const body = (...children: object[]) => ({ content: { editorState: { root: { type: 'root', children: [{ type: 'paragraph', children }] } } } });
  const page = (id: string, extra: Partial<DemoGraphPage> = {}): DemoGraphPage => ({ id, title: id, parentId: null, icon: null, deleted: false, ...extra });
  const graph = demoGraph([
    page('home', { snapshot: body(reference('note'), reference('note'), reference('home'), reference('gone'), reference('row')) }),
    page('note', { parentId: 'home' }), page('db', { kind: 'database' }),
    page('row', { kind: 'row', parentId: 'db', snapshot: body(reference('home')) }),
    page('gone', { deleted: true, snapshot: body(reference('home')) }),
  ]);
  expect(graph.nodes.map(item => [item.id, item.kind, item.parentId])).toEqual([['home', 'document', null], ['note', 'document', 'home'], ['db', 'database', null]]);
  expect(graph.edges.map(item => [item.source, item.target, item.count])).toEqual([['home', 'note', 2], ['db', 'home', 1], ['home', 'db', 1]]);
  expect(graph.truncated).toBe(false);
  expect(demoGraph([])).toEqual({ nodes: [], edges: [], truncated: false });
});
