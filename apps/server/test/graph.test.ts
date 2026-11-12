import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import type { AuthRepository } from '../src/auth/repository.js';
import { assembleGraph, type GraphEdgeRow, type GraphNodeRow } from '../src/graph/graph.js';

const node = (id: string, parent: string | null = null, kind = 'document'): GraphNodeRow =>
  ({ id, title: `页面 ${id}`, icon: null, kind, parent_id: parent, tag_ids: null });
const edge = (source: string, target: string, count = 1, kind = 'page-reference'): GraphEdgeRow => ({ source, target, kind, count });

test('graph assembly keeps only edges and parents inside the returned nodes', () => {
  const graph = assembleGraph([node('a'), node('b', 'a'), node('c', 'missing', 'database'), node('d', 'd')],
    [edge('a', 'b', 3), edge('b', 'a'), edge('a', 'gone'), edge('c', 'c'), edge('c', 'a', 2, 'future-kind')]);
  assert.deepEqual(graph.nodes.map(item => [item.id, item.kind, item.parentId, item.tagIds]),
    [['a', 'document', null, []], ['b', 'document', 'a', []], ['c', 'database', null, []], ['d', 'document', null, []]]);
  assert.deepEqual(graph.edges, [
    { source: 'a', target: 'b', kind: 'page-reference', count: 3 },
    { source: 'b', target: 'a', kind: 'page-reference', count: 1 },
    { source: 'c', target: 'a', kind: 'page-reference', count: 2 },
  ]);
  assert.equal(graph.truncated, false);
});

test('graph assembly applies node and edge limits and reports truncation', () => {
  const nodes = assembleGraph([node('a'), node('b'), node('c', 'a')], [edge('a', 'b'), edge('a', 'c')], 2, 10);
  assert.deepEqual(nodes.nodes.map(item => item.id), ['a', 'b']);
  assert.deepEqual(nodes.edges.map(item => item.target), ['b']);
  assert.equal(nodes.truncated, true);
  const edges = assembleGraph([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('a', 'c'), edge('b', 'c')], 10, 2);
  assert.equal(edges.edges.length, 2);
  assert.equal(edges.truncated, true);
  assert.deepEqual(assembleGraph([], []), { nodes: [], edges: [], truncated: false });
});

test('graph route is absent without a database and requires a session', async (t) => {
  const bare = await buildApp();
  t.after(() => bare.close());
  const path = '/api/workspaces/11111111-1111-4111-8111-111111111111/graph';
  assert.equal((await bare.inject(path)).statusCode, 404);
  const configured = await buildApp({ auth: { repository: {} as AuthRepository, publicOrigin: 'http://127.0.0.1:3001' },
    pages: {} as never, notesPool: {} as never });
  t.after(() => configured.close());
  assert.equal((await configured.inject(path)).statusCode, 401);
  assert.equal((await configured.inject('/api/workspaces/not-a-uuid/graph')).statusCode, 404);
});
