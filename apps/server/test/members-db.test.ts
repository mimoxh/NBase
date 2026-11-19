import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { AuthSessionResponse, CreateInvitationResponse, InvitationListResponse, MemberListResponse, WorkspaceMember } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const ownerPassword = 'local integration password only';
const memberPassword = 'member password fifteen plus';
const content = (text: string) => ({ schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [{
  type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text }],
}] } } });

test('invitation links, one-time acceptance, roles, removal and restore', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance', timeout: 120000,
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
  let limited: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(sourceUrl);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 6, connectionTimeoutMillis: 5000 });
    const db = pool;
    assert.ok(await runMigrations(pool) >= 26);
    const owner = await initializeOwner(pool, 'owner', await hashPassword(ownerPassword), '成员测试');
    const options = () => ({ auth: { repository: new PgAuthRepository(db), publicOrigin: origin }, pages: new PgPageRepository(db),
      notesPool: db, calendar: { scheduler: false } });
    app = await buildApp(options());
    const server = app;
    const base = `/api/workspaces/${owner.workspaceId}`;
    let ip = 10;
    // The public routes count failures per address; each refusal below comes from its own address.
    const nextIp = () => `192.0.2.${ip++}`;
    const login = async (loginName: string, password: string) => {
      const response = await server.inject({ method: 'POST', url: '/api/auth/login', headers: { origin },
        payload: { loginName, password }, remoteAddress: nextIp() });
      return response;
    };
    const headersFor = (response: { headers: Record<string, unknown>; json: () => unknown }) => {
      const cookie = String(response.headers['set-cookie']).split(';', 1)[0]!;
      return { read: { cookie }, write: { cookie, origin, 'x-csrf-token': (response.json() as AuthSessionResponse).csrfToken } };
    };
    const ownerHeaders = headersFor(await login('owner', ownerPassword));
    const call = (headers: { read: Record<string, string>; write: Record<string, string> }, method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, payload?: unknown) =>
      server.inject({ method, url: `${base}${path}`, headers: method === 'GET' ? headers.read : headers.write,
        ...(method === 'GET' ? {} : { payload: (payload ?? {}) as object }) });
    const invite = async (role: string, expiresInDays?: number) => {
      const response = await call(ownerHeaders, 'POST', '/invitations', { role, ...(expiresInDays ? { expiresInDays } : {}) });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<CreateInvitationResponse>();
    };
    const status = (token: string, headers: Record<string, string> = {}) => server.inject({ method: 'GET', url: '/api/invitations/status',
      headers: { 'x-nbase-invite': token, ...headers }, remoteAddress: nextIp() });
    const accept = (token: string, loginName: string, password = memberPassword, remoteAddress = nextIp()) => server.inject({
      method: 'POST', url: '/api/invitations/accept', headers: { origin }, payload: { token, loginName, password }, remoteAddress });

    // Creating: the link carries the token in the fragment, the database only its digest.
    const editorInvite = await invite('editor');
    assert.match(editorInvite.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(editorInvite.url, `${origin}/#invite=${editorInvite.token}`);
    assert.equal(editorInvite.invitation.status, 'pending');
    assert.equal(editorInvite.invitation.role, 'editor');
    const lifetime = Date.parse(editorInvite.invitation.expiresAt) - Date.parse(editorInvite.invitation.createdAt);
    assert.ok(Math.abs(lifetime - 7 * 86400000) < 1000, 'defaults to seven days');
    const stored = await db.query<{ token_hash: Buffer }>('SELECT token_hash FROM workspace_invitations WHERE id = $1', [editorInvite.invitation.id]);
    assert.deepEqual(stored.rows[0]!.token_hash, createHash('sha256').update(Buffer.from(editorInvite.token, 'base64url')).digest());
    const rows = JSON.stringify((await db.query('SELECT * FROM workspace_invitations')).rows);
    assert.ok(!rows.includes(editorInvite.token));
    const viewerInvite = await invite('viewer', 1);
    assert.equal((await call(ownerHeaders, 'POST', '/invitations', { role: 'owner' })).statusCode, 400);
    assert.equal((await call(ownerHeaders, 'POST', '/invitations', { role: 'viewer', expiresInDays: 3 })).statusCode, 400);
    assert.equal((await server.inject({ method: 'POST', url: `${base}/invitations`, headers: { ...ownerHeaders.write, origin: 'http://elsewhere.test' },
      payload: { role: 'viewer' } })).statusCode, 403);
    assert.equal((await server.inject({ method: 'POST', url: `${base}/invitations`, headers: { ...ownerHeaders.write, 'x-csrf-token': 'x'.repeat(43) },
      payload: { role: 'viewer' } })).statusCode, 403);

    // Public status shows only the workspace name and role, and only while the invitation is usable.
    const pending = await status(editorInvite.token);
    assert.equal(pending.statusCode, 200);
    assert.equal(pending.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(pending.json()).sort(), ['expiresAt', 'role', 'status', 'workspaceName']);
    assert.equal(pending.json().workspaceName, '成员测试');
    assert.equal((await status('a'.repeat(43))).statusCode, 404);
    assert.equal((await status('short')).statusCode, 404);
    assert.equal((await status(editorInvite.token, { origin: 'http://elsewhere.test' })).statusCode, 403);

    // Accepting: validation, name clashes and the one-time rule.
    assert.equal((await accept(editorInvite.token, 'Bad Name')).json().error, 'LOGIN_NAME_INVALID');
    assert.equal((await accept(editorInvite.token, 'editor', 'x'.repeat(14))).json().error, 'PASSWORD_TOO_SHORT');
    const taken = await accept(editorInvite.token, 'owner');
    assert.equal(taken.statusCode, 409);
    assert.equal(taken.json().error, 'LOGIN_TAKEN');
    assert.equal((await server.inject({ method: 'POST', url: '/api/invitations/accept', headers: { origin: 'http://elsewhere.test' },
      payload: { token: editorInvite.token, loginName: 'editor', password: memberPassword } })).statusCode, 403);
    // Two people opening the same link at once: exactly one account is created.
    const race = await Promise.all([accept(editorInvite.token, 'editor'), accept(editorInvite.token, 'editor-two')]);
    assert.deepEqual(race.map(item => item.statusCode).sort(), [201, 409]);
    const accepted = race.find(item => item.statusCode === 201)!;
    const loser = race.find(item => item.statusCode === 409)!;
    assert.equal(loser.json().error, 'INVITATION_USED');
    const editorName = (accepted.json() as AuthSessionResponse).user.loginName;
    assert.equal((accepted.json() as AuthSessionResponse).workspaces[0]!.role, 'editor');
    assert.match(String(accepted.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    assert.equal(accepted.headers['cache-control'], 'no-store');
    assert.equal((await db.query('SELECT 1 FROM users WHERE login_name = ANY($1)', [['editor', 'editor-two']])).rowCount, 1);
    let editor = headersFor(accepted);
    assert.equal((await server.inject({ method: 'GET', url: '/api/auth/session', headers: editor.read })).statusCode, 200);
    assert.deepEqual((await status(editorInvite.token)).json(), { status: 'accepted' });
    assert.equal((await accept(editorInvite.token, 'editor-three')).json().error, 'INVITATION_USED');

    // The editor writes pages and keeps a favorite; member management stays with the owner.
    const page = await call(editor, 'POST', '/pages', { clientMutationId: randomUUID(), parentId: null, title: '编辑者页面', content: content('一') });
    assert.equal(page.statusCode, 201, page.body);
    const pageId = page.json().id as string;
    assert.equal((await call(editor, 'PUT', `/favorites/${pageId}`)).statusCode, 204);
    for (const [method, path] of [['GET', '/members'], ['GET', '/invitations'], ['POST', '/invitations'],
      ['PATCH', `/members/${owner.userId}`], ['POST', `/members/${owner.userId}/remove`]] as const) {
      assert.equal((await call(editor, method, path, method === 'PATCH' ? { role: 'viewer' } : { role: 'viewer' })).statusCode, 403, `${method} ${path}`);
    }

    // Revoked and expired invitations cannot be used; an accepted one cannot be revoked.
    const revokedInvite = await invite('editor', 30);
    const revoked = await call(ownerHeaders, 'POST', `/invitations/${revokedInvite.invitation.id}/revoke`);
    assert.equal(revoked.statusCode, 200);
    assert.equal(revoked.json().status, 'revoked');
    assert.equal((await call(ownerHeaders, 'POST', `/invitations/${revokedInvite.invitation.id}/revoke`)).statusCode, 200);
    assert.deepEqual((await status(revokedInvite.token)).json(), { status: 'revoked' });
    assert.equal((await accept(revokedInvite.token, 'late')).json().error, 'INVITATION_REVOKED');
    assert.equal((await call(ownerHeaders, 'POST', `/invitations/${editorInvite.invitation.id}/revoke`)).json().error, 'INVITATION_USED');
    const expiredInvite = await invite('viewer');
    await db.query("UPDATE workspace_invitations SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE id = $1",
      [expiredInvite.invitation.id]);
    assert.deepEqual((await status(expiredInvite.token)).json(), { status: 'expired' });
    assert.equal((await accept(expiredInvite.token, 'late')).json().error, 'INVITATION_EXPIRED');
    assert.equal((await db.query("SELECT 1 FROM users WHERE login_name = 'late'")).rowCount, 0);

    const viewerAccepted = await accept(viewerInvite.token, 'viewer');
    assert.equal(viewerAccepted.statusCode, 201, viewerAccepted.body);
    const viewer = headersFor(viewerAccepted);
    assert.equal((await call(viewer, 'GET', `/pages/${pageId}`)).statusCode, 200);
    assert.equal((await call(viewer, 'PATCH', `/pages/${pageId}`, { clientMutationId: randomUUID(), expectedRevision: '1', title: '改' })).statusCode, 403);
    assert.equal((await call(viewer, 'PUT', `/favorites/${pageId}`)).statusCode, 204, 'favorites are personal');

    const listed = await call(ownerHeaders, 'GET', '/invitations');
    assert.deepEqual(listed.json<InvitationListResponse>().invitations.map(item => item.status).sort(),
      ['accepted', 'accepted', 'expired', 'revoked']);
    assert.equal(listed.json<InvitationListResponse>().invitations.find(item => item.id === viewerInvite.invitation.id)?.acceptedLoginName, 'viewer');
    assert.ok(!listed.body.includes(viewerInvite.token));
    const memberList = async () => (await call(ownerHeaders, 'GET', '/members')).json<MemberListResponse>().members;
    const find = async (loginName: string) => (await memberList()).find(item => item.loginName === loginName)!;
    assert.deepEqual((await memberList()).map(item => [item.loginName, item.role]), [['owner', 'owner'], [editorName, 'editor'], ['viewer', 'viewer']]);
    const editorMember = await find(editorName);
    assert.ok(editorMember.lastLoginAt);
    assert.equal(editorMember.removedAt, null);

    // The owner cannot demote or remove themselves, and there is never a second owner.
    assert.equal((await call(ownerHeaders, 'PATCH', `/members/${owner.userId}`, { role: 'viewer' })).json().error, 'MEMBER_OWNER');
    assert.equal((await call(ownerHeaders, 'POST', `/members/${owner.userId}/remove`)).json().error, 'MEMBER_OWNER');
    assert.equal((await call(ownerHeaders, 'PATCH', `/members/${editorMember.userId}`, { role: 'owner' })).statusCode, 400);
    assert.equal((await call(ownerHeaders, 'PATCH', `/members/${randomUUID()}`, { role: 'viewer' })).statusCode, 404);

    // Changing a role signs the member out; the next session has the new role.
    const demoted = await call(ownerHeaders, 'PATCH', `/members/${editorMember.userId}`, { role: 'viewer' });
    assert.equal(demoted.statusCode, 200);
    assert.equal(demoted.json<WorkspaceMember>().role, 'viewer');
    assert.equal((await call(editor, 'GET', '/page-tree')).statusCode, 401);
    editor = headersFor(await login(editorName, memberPassword));
    assert.equal((await call(editor, 'PATCH', `/pages/${pageId}`, { clientMutationId: randomUUID(), expectedRevision: '1', title: '改' })).statusCode, 403);
    assert.equal((await call(ownerHeaders, 'PATCH', `/members/${editorMember.userId}`, { role: 'editor' })).statusCode, 200);
    editor = headersFor(await login(editorName, memberPassword));

    // Removal: sessions end at once, login looks like a wrong password, personal rows stay for a restore.
    const epoch = (await db.query<{ auth_epoch: string }>('SELECT auth_epoch FROM users WHERE id = $1', [editorMember.userId])).rows[0]!.auth_epoch;
    const removed = await call(ownerHeaders, 'POST', `/members/${editorMember.userId}/remove`);
    assert.equal(removed.statusCode, 200);
    assert.ok(removed.json<WorkspaceMember>().removedAt);
    assert.equal((await db.query<{ auth_epoch: string }>('SELECT auth_epoch FROM users WHERE id = $1', [editorMember.userId])).rows[0]!.auth_epoch,
      String(Number(epoch) + 1));
    assert.equal((await db.query('SELECT 1 FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [editorMember.userId])).rowCount, 0);
    assert.equal((await call(editor, 'GET', `/pages/${pageId}`)).statusCode, 401);
    assert.equal((await call(editor, 'PATCH', `/pages/${pageId}`, { clientMutationId: randomUUID(), expectedRevision: '1', title: '改' })).statusCode, 401);
    const refused = await login(editorName, memberPassword);
    assert.equal(refused.statusCode, 401);
    assert.equal(refused.json().error, 'AUTH_INVALID');
    assert.deepEqual(refused.json(), (await login(editorName, 'a wrong password for comparison')).json());
    assert.equal((await db.query('SELECT 1 FROM page_favorites WHERE user_id = $1', [editorMember.userId])).rowCount, 1);
    assert.equal((await call(ownerHeaders, 'POST', `/members/${editorMember.userId}/remove`)).statusCode, 200, 'idempotent');
    assert.ok((await find(editorName)).removedAt);
    // A session that somehow survived removal still finds no workspace.
    const lingering = headersFor(await login('viewer', memberPassword));
    await db.query('UPDATE workspace_memberships SET removed_at = now() WHERE user_id = (SELECT id FROM users WHERE login_name = $1)', ['viewer']);
    assert.equal((await call(lingering, 'GET', `/pages/${pageId}`)).statusCode, 404);
    assert.equal((await call(lingering, 'PUT', `/favorites/${pageId}`)).statusCode, 404);
    assert.equal((await server.inject({ method: 'GET', url: '/api/auth/session', headers: lingering.read })).statusCode, 401);
    await db.query('UPDATE workspace_memberships SET removed_at = NULL WHERE user_id = (SELECT id FROM users WHERE login_name = $1)', ['viewer']);

    const restored = await call(ownerHeaders, 'POST', `/members/${editorMember.userId}/restore`);
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json<WorkspaceMember>().removedAt, null);
    editor = headersFor(await login(editorName, memberPassword));
    assert.deepEqual((await call(editor, 'GET', '/favorites')).json().pageIds, [pageId]);
    assert.equal((await call(editor, 'PATCH', `/pages/${pageId}`, { clientMutationId: randomUUID(), expectedRevision: '1', title: '恢复后' })).statusCode, 200);

    // The database itself keeps the owner a member and invitations single-use.
    await assert.rejects(db.query('UPDATE workspace_memberships SET removed_at = now() WHERE user_id = $1', [owner.userId]), /owner_stays/);
    await assert.rejects(db.query("UPDATE workspace_invitations SET role = 'owner'"), /check/);

    // Failures per address are limited on the public routes.
    const limitedApp = await buildApp(options());
    limited = limitedApp;
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await limitedApp.inject({ method: 'GET', url: '/api/invitations/status', headers: { 'x-nbase-invite': 'b'.repeat(43) } });
      assert.equal(response.statusCode, 404);
    }
    const blocked = await limitedApp.inject({ method: 'GET', url: '/api/invitations/status', headers: { 'x-nbase-invite': revokedInvite.token } });
    assert.equal(blocked.statusCode, 429);
    assert.equal((await limitedApp.inject({ method: 'POST', url: '/api/invitations/accept', headers: { origin },
      payload: { token: revokedInvite.token, loginName: 'blocked', password: memberPassword } })).statusCode, 429);
  } finally {
    await limited?.close();
    await app?.close();
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
});
