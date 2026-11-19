import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import type { AuthSessionResponse, CreateInvitationResponse, DatabaseDocument } from '@nbase/contracts';
import type { RouteOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { PgAttachmentRepository } from '../src/attachments/repository.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const ownerPassword = 'local integration password only';
const memberPassword = 'member password fifteen plus';
const workspacePrefix = '/api/workspaces/:workspaceId/';
/** Writes outside a workspace: signing in and out, and accepting an invitation. */
const publicWrites = ['POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/invitations/accept'];

interface Probe { payload?: unknown; contentType?: string; query?: string }

test('every workspace write route refuses viewers and removed members', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance', timeout: 180000,
}, async () => {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  assert.equal(source.pathname, '/nbase_p2');
  const admin = new pg.Pool({ connectionString: sourceUrl, max: 2, connectionTimeoutMillis: 5000 });
  const name = `nbase_p2_test_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  let pool: pg.Pool | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let attachmentRoot: string | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(sourceUrl);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 6, connectionTimeoutMillis: 5000 });
    const db = pool;
    await runMigrations(pool);
    attachmentRoot = await mkdtemp(join(tmpdir(), 'nbase-route-audit-'));
    const owner = await initializeOwner(pool, 'owner', await hashPassword(ownerPassword), '审计');
    const routes: { method: string; url: string }[] = [];
    app = await buildApp({ auth: { repository: new PgAuthRepository(db), publicOrigin: origin }, pages: new PgPageRepository(db),
      attachments: new PgAttachmentRepository(db, attachmentRoot), notesPool: db, calendar: { scheduler: false },
      onRoute: (route: RouteOptions) => {
        for (const method of [route.method].flat()) routes.push({ method, url: route.url });
      } });
    const server = app;
    await server.ready();
    let ip = 10;
    const login = async (loginName: string, password: string) => {
      const response = await server.inject({ method: 'POST', url: '/api/auth/login', headers: { origin },
        payload: { loginName, password }, remoteAddress: `192.0.2.${ip++}` });
      assert.equal(response.statusCode, 200, response.body);
      const cookie = String(response.headers['set-cookie']).split(';', 1)[0]!;
      return { cookie, csrf: (response.json() as AuthSessionResponse).csrfToken };
    };
    const ownerSession = await login('owner', ownerPassword);
    const base = `/api/workspaces/${owner.workspaceId}`;
    const ownerWrite = { cookie: ownerSession.cookie, origin, 'x-csrf-token': ownerSession.csrf };
    const page = await server.inject({ method: 'POST', url: `${base}/pages`, headers: ownerWrite,
      payload: { clientMutationId: randomUUID(), parentId: null, title: '审计页面', content: { schemaVersion: 1, editorState: { root: {
        type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, children: [] }] } } } } });
    assert.equal(page.statusCode, 201, page.body);
    const pageId = page.json().id as string;
    const database = await server.inject({ method: 'POST', url: `${base}/databases`, headers: ownerWrite,
      payload: { clientMutationId: randomUUID(), parentId: null, title: '审计表' } });
    assert.equal(database.statusCode, 201, database.body);
    const databaseId = database.json<DatabaseDocument>().page.id;
    const invitation = await server.inject({ method: 'POST', url: `${base}/invitations`, headers: ownerWrite, payload: { role: 'viewer' } });
    assert.equal(invitation.statusCode, 201, invitation.body);
    const accepted = await server.inject({ method: 'POST', url: '/api/invitations/accept', headers: { origin },
      payload: { token: invitation.json<CreateInvitationResponse>().token, loginName: 'viewer', password: memberPassword } });
    assert.equal(accepted.statusCode, 201, accepted.body);
    const viewerId = (accepted.json() as AuthSessionResponse).user.id;
    const viewerSession = (accepted.json() as AuthSessionResponse);
    const viewerCookie = String(accepted.headers['set-cookie']).split(';', 1)[0]!;
    // The viewer's own thread and comments, so editing and deleting own comments has real targets.
    const threadId = randomUUID();
    const ownCommentId = randomUUID();
    const deletableCommentId = randomUUID();
    const viewerWrite = { cookie: viewerCookie, origin, 'x-csrf-token': viewerSession.csrfToken };
    const anchor = { blockId: null, path: [0], quote: '' };
    const thread = await server.inject({ method: 'POST', url: `${base}/pages/${pageId}/comments`, headers: viewerWrite,
      payload: { id: threadId, commentId: ownCommentId, anchor, body: '只读成员的评论' } });
    assert.equal(thread.statusCode, 201, thread.body);
    const second = await server.inject({ method: 'POST', url: `${base}/comment-threads/${threadId}/replies`, headers: viewerWrite,
      payload: { id: deletableCommentId, body: '待删除' } });
    assert.equal(second.statusCode, 201, second.body);

    // Reads that travel as POST, and personal preferences: viewers may use these, with real targets.
    const postRead: Record<string, Probe> = {
      'POST /api/workspaces/:workspaceId/databases/:pageId/query': { payload: { filters: [], sorts: [] } },
      'POST /api/workspaces/:workspaceId/databases/:pageId/aggregate': { payload: { filters: [], items: [] } },
      'POST /api/workspaces/:workspaceId/databases/:pageId/rows/read': { payload: { ids: [] } },
      'PUT /api/workspaces/:workspaceId/calendar/settings': { payload: { sources: [], showDailyNotes: false, defaultDatabaseId: null } },
      'POST /api/workspaces/:workspaceId/calendar/events': { payload: { from: '2026-03-01', to: '2026-03-31' } },
      'POST /api/workspaces/:workspaceId/calendar/reminders': { payload: { from: '2026-03-10T00:00:00Z', to: '2026-03-11T00:00:00Z' } },
      'PUT /api/workspaces/:workspaceId/favorites/:pageId': {},
      'DELETE /api/workspaces/:workspaceId/favorites/:pageId': {},
      // Viewers may comment: start a thread, reply, and edit or delete their own comments.
      'POST /api/workspaces/:workspaceId/pages/:pageId/comments': { payload: { id: randomUUID(), commentId: randomUUID(), anchor, body: '新讨论' } },
      'POST /api/workspaces/:workspaceId/comment-threads/:threadId/replies': { payload: { id: randomUUID(), body: '回复' } },
      'PATCH /api/workspaces/:workspaceId/comments/:commentId': { payload: { body: '改过的评论' } },
      'POST /api/workspaces/:workspaceId/comments/:commentId/delete': {},
    };
    // Writes whose body is not JSON; the rest get an empty JSON object, since the role check comes before validation.
    const writeProbes: Record<string, Probe> = {
      'PUT /api/workspaces/:workspaceId/attachments/:attachmentId': { contentType: 'application/octet-stream', payload: Buffer.from('x'), query: '?name=a.txt' },
    };

    const writes = routes.filter(route => !['GET', 'HEAD'].includes(route.method));
    const keys = writes.map(route => `${route.method} ${route.url}`);
    assert.deepEqual(keys.filter(key => !key.split(' ')[1]!.startsWith(workspacePrefix)).sort(), [...publicWrites].sort(),
      'a new write outside a workspace needs its own authorization review');
    for (const key of Object.keys(postRead)) assert.ok(keys.includes(key), `stale entry ${key}`);
    const workspaceWrites = writes.filter(route => route.url.startsWith(workspacePrefix));
    assert.ok(workspaceWrites.length >= 50, `found only ${workspaceWrites.length} write routes`);
    const workspaceReads = routes.filter(route => route.method === 'GET' && route.url.startsWith(workspacePrefix));

    const target = (route: { url: string }, query = '') => route.url.replaceAll(/:([A-Za-z]+)/g, (_match, param: string) => {
      if (param === 'workspaceId') return owner.workspaceId;
      if (param === 'pageId') return route.url.includes('/databases/') ? databaseId : pageId;
      if (param === 'revision') return '1';
      if (param === 'provider') return 'google';
      if (param === 'threadId') return threadId;
      if (param === 'commentId') return route.url.endsWith('/delete') ? deletableCommentId : ownCommentId;
      return randomUUID();
    }) + query;
    const send = (session: { cookie: string; csrf: string }, route: { method: string; url: string }) => {
      const key = `${route.method} ${route.url}`;
      const probe = postRead[key] ?? writeProbes[key] ?? {};
      return server.inject({ method: route.method as 'POST', url: target(route, probe.query),
        headers: { cookie: session.cookie, origin, 'x-csrf-token': session.csrf, 'content-type': probe.contentType ?? 'application/json' },
        payload: (probe.payload ?? {}) as object });
    };

    const viewer = await login('viewer', memberPassword);
    const refusedViewer: string[] = [];
    for (const route of workspaceWrites) {
      const key = `${route.method} ${route.url}`;
      const response = await send(viewer, route);
      if (key in postRead) {
        assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${key} should serve viewers: ${response.statusCode} ${response.body}`);
      } else {
        assert.equal(response.statusCode, 403, `${key}: ${response.body}`);
        assert.equal(response.json().error, 'FORBIDDEN', key);
        refusedViewer.push(key);
      }
    }
    assert.equal(refusedViewer.length + Object.keys(postRead).length, workspaceWrites.length);
    assert.equal((await db.query('SELECT 1 FROM pages WHERE workspace_id = $1 AND deleted_at IS NULL', [owner.workspaceId])).rowCount, 2,
      'nothing a viewer sent created or removed a page');

    // A session that outlived its membership finds no workspace, for reads and writes alike.
    await db.query('UPDATE workspace_memberships SET removed_at = now() WHERE user_id = $1', [viewerId]);
    for (const route of workspaceWrites) {
      const response = await send(viewer, route);
      assert.equal(response.statusCode, 404, `${route.method} ${route.url}: ${response.body}`);
    }
    for (const route of workspaceReads) {
      const response = await server.inject({ method: 'GET', url: target(route), headers: { cookie: viewer.cookie } });
      assert.ok([401, 404].includes(response.statusCode), `GET ${route.url}: ${response.statusCode} ${response.body}`);
    }
    await db.query('UPDATE workspace_memberships SET removed_at = NULL WHERE user_id = $1', [viewerId]);

    // Removal through the owner's route ends the session itself.
    const removed = await server.inject({ method: 'POST', url: `${base}/members/${viewerId}/remove`, headers: ownerWrite, payload: {} });
    assert.equal(removed.statusCode, 200, removed.body);
    for (const route of workspaceWrites) {
      const response = await send(viewer, route);
      assert.equal(response.statusCode, 401, `${route.method} ${route.url}: ${response.body}`);
    }
  } finally {
    await app?.close();
    await pool?.end();
    if (attachmentRoot) await rm(attachmentRoot, { recursive: true, force: true });
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
});
