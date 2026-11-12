import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { DatabaseDocument, PageDocument, WorkspaceGraphResponse } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { loadWorkspaceGraph } from '../src/graph/graph.js';
import { PgPageRepository } from '../src/pages/repository.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const password = 'graph integration password only';
const text = (value: string) => ({ type: 'text', version: 1, text: value });
const ref = (targetPageId: string, label: string) => ({ type: 'page-reference', version: 1, targetPageId, label });
const content = (...children: object[]) => ({ schemaVersion: 1, editorState: { root: {
  type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, children }],
} } });

test('workspace graph aggregates saved links between active pages of one workspace', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, async () => {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  assert.equal(source.pathname, '/nbase_p2');
  const database = `nbase_p2_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: source.toString(), connectionTimeoutMillis: 5000 });
  const testUrl = new URL(source);
  testUrl.pathname = `/${database}`;
  const pool = new pg.Pool({ connectionString: testUrl.toString(), connectionTimeoutMillis: 5000 });
  const app = await buildApp({ auth: { repository: new PgAuthRepository(pool), publicOrigin: origin },
    pages: new PgPageRepository(pool), notesPool: pool });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    await runMigrations(pool);
    const owner = await initializeOwner(pool, 'owner', await hashPassword(password), '关系图测试');
    const base = `/api/workspaces/${owner.workspaceId}`;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { loginName: 'owner', password } });
    assert.equal(login.statusCode, 200);
    const read = { cookie: String(login.headers['set-cookie']).split(';', 1)[0]! };
    const write = { ...read, origin, 'x-csrf-token': login.json().csrfToken as string };
    const mutate = (method: 'POST' | 'PATCH', path: string, payload: object) =>
      app.inject({ method, url: base + path, headers: write, payload: { clientMutationId: randomUUID(), ...payload } });
    const create = async (title: string, body = content(text(title)), extra: object = { parentId: null }) => {
      const response = await mutate('POST', '/pages', { title, content: body, ...extra });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<PageDocument>();
    };
    const action = async (page: PageDocument, kind: 'trash' | 'restore') => {
      const response = await mutate('POST', `/pages/${page.id}/${kind}`, { expectedRevision: page.revision });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<PageDocument>();
    };
    const graph = async () => {
      const response = await app.inject({ url: `${base}/graph`, headers: read });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'no-store');
      return response.json<WorkspaceGraphResponse>();
    };
    const edges = (data: WorkspaceGraphResponse) => data.edges.map(edge => [edge.source, edge.target, edge.count]);
    const sorted = (rows: (string | number)[][]) => rows.map(row => row.join('>')).sort();

    assert.deepEqual(await graph(), { nodes: [], edges: [], truncated: false });
    assert.equal((await app.inject({ url: `${base}/graph` })).statusCode, 401);

    const hub = await create('枢纽');
    const leaf = await create('叶子', content(text('子页')), { parentId: hub.id });
    const lonely = await create('孤立');
    // Two references to the hub and one to itself: aggregated to count 2, the self link is dropped.
    let note = await create('笔记', content(ref(hub.id, '枢纽'), text(' 与 '), ref(hub.id, '再次'), text(' '), ref(leaf.id, '叶子')));
    note = (await mutate('PATCH', `/pages/${note.id}`, { expectedRevision: note.revision,
      content: content(ref(hub.id, '枢纽'), text(' 与 '), ref(hub.id, '再次'), text(' '), ref(leaf.id, '叶子'), ref(note.id, '自己')) })).json<PageDocument>();
    await create('回链', content(ref(note.id, '笔记')), { parentId: hub.id });

    const first = await graph();
    assert.equal(first.truncated, false);
    assert.deepEqual(first.nodes.map(node => node.title).sort(), ['叶子', '回链', '孤立', '枢纽', '笔记']);
    assert.equal(first.nodes.find(node => node.id === leaf.id)!.parentId, hub.id);
    assert.deepEqual(first.nodes.find(node => node.id === hub.id), { id: hub.id, title: '枢纽', icon: null, kind: 'document', parentId: null, tagIds: [] });
    const backId = first.nodes.find(node => node.title === '回链')!.id;
    assert.deepEqual(sorted(edges(first)), sorted([[note.id, hub.id, 2], [note.id, leaf.id, 1], [backId, note.id, 1]]));
    assert.ok(first.edges.every(edge => edge.kind === 'page-reference'));
    assert.equal(first.edges[0]!.count, 2);

    // Rows fold into their database on both ends.
    const dbResponse = await mutate('POST', '/databases', { parentId: null, title: '任务库' });
    assert.ok(dbResponse.statusCode < 300, dbResponse.body);
    const db = dbResponse.json<DatabaseDocument>();
    const row = await create('任务一', content(ref(hub.id, '枢纽'), ref(lonely.id, '孤立')), { parentId: db.page.id, properties: {} });
    await create('任务二', content(ref(hub.id, '枢纽')), { parentId: db.page.id, properties: {} });
    await create('指向行', content(ref(row.id, '任务一')));
    const folded = await graph();
    assert.ok(!folded.nodes.some(node => node.id === row.id));
    assert.equal(folded.nodes.find(node => node.id === db.page.id)!.kind, 'database');
    const pointer = folded.nodes.find(node => node.title === '指向行')!.id;
    assert.deepEqual(sorted(edges(folded).filter(item => item.includes(db.page.id))),
      sorted([[db.page.id, hub.id, 2], [db.page.id, lonely.id, 1], [pointer, db.page.id, 1]]));

    // Trashed sources and targets leave the graph and return on restore.
    const trashedHub = await action((await app.inject({ url: `${base}/pages/${hub.id}`, headers: read })).json<PageDocument>(), 'trash');
    const withoutHub = await graph();
    assert.ok(!withoutHub.nodes.some(node => [hub.id, leaf.id, backId].includes(node.id)));
    assert.ok(!withoutHub.edges.some(edge => [edge.source, edge.target].some(id => [hub.id, leaf.id, backId].includes(id))));
    assert.ok(withoutHub.edges.some(edge => edge.source === db.page.id && edge.target === lonely.id));
    await action(trashedHub, 'restore');
    assert.deepEqual(sorted(edges(await graph())), sorted(edges(folded)));

    // Bounds: the most recently updated pages stay, edges only among them.
    const bounded = await loadWorkspaceGraph(pool, owner.workspaceId, owner.userId, 3, 10);
    assert.equal(bounded.nodes.length, 3);
    assert.equal(bounded.truncated, true);
    const boundedIds = new Set(bounded.nodes.map(node => node.id));
    assert.ok(bounded.edges.every(edge => boundedIds.has(edge.source) && boundedIds.has(edge.target)));
    assert.ok(bounded.nodes.every(node => node.parentId === null || boundedIds.has(node.parentId)));
    const fewEdges = await loadWorkspaceGraph(pool, owner.workspaceId, owner.userId, 2000, 2);
    assert.equal(fewEdges.edges.length, 2);
    assert.equal(fewEdges.truncated, true);
    assert.equal(fewEdges.edges[0]!.count, 2);

    // Membership: another workspace is invisible, and its pages never leak into this graph.
    const foreignWorkspace = randomUUID(), foreignPage = randomUUID(), stranger = randomUUID();
    await pool.query('INSERT INTO workspaces (id, name, owner_user_id) VALUES ($1, $2, $3)', [foreignWorkspace, '外部', owner.userId]);
    await pool.query(`INSERT INTO pages (id, workspace_id, title, content_json, content_schema_version)
      VALUES ($1, $2, $3, $4, 1)`, [foreignPage, foreignWorkspace, '外部页面', JSON.stringify(content(text('外部')))]);
    assert.equal((await app.inject({ url: `/api/workspaces/${foreignWorkspace}/graph`, headers: read })).statusCode, 404);
    assert.ok(!(await graph()).nodes.some(node => node.id === foreignPage));
    assert.deepEqual(await loadWorkspaceGraph(pool, owner.workspaceId, stranger), { nodes: [], edges: [], truncated: false });
    assert.deepEqual(await loadWorkspaceGraph(pool, foreignWorkspace, owner.userId), { nodes: [], edges: [], truncated: false });

    await pool.query("UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2",
      [owner.workspaceId, owner.userId]);
    assert.equal((await graph()).nodes.length, folded.nodes.length);
  } finally {
    await app.close();
    await pool.end();
    try { if (created) await admin.query(`DROP DATABASE "${database}"`); }
    finally { await admin.end(); }
  }
});
