import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import type {
  AuthSessionResponse, CommentThread, CommentThreadListResponse, CreateInvitationResponse, CreatePageShareResponse, LiveServerMessage,
  PageDocument, PageShareListResponse, SharedPageResponse, SharedRootResponse,
} from '@nbase/contracts';
import { liveCloseAuth } from '@nbase/contracts';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { PgAttachmentRepository } from '../src/attachments/repository.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import type { LiveHub } from '../src/live/hub.js';
import { PgPageRepository } from '../src/pages/repository.js';
import { isLocalNetworkAddress } from '../src/shares/routes.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const ownerPassword = 'local integration password only';
const memberPassword = 'member password fifteen plus';
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

const doc = (text: string, extra: unknown[] = []) => ({ schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [
  { type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text }] }, ...extra] } } });
const attachmentNode = (id: string) => ({ type: 'paragraph', version: 1, children: [
  { type: 'attachment', version: 1, attachmentId: id, alt: '', fileName: 'dot.png', mediaType: 'image/png' }] });

test('presence, last editor, comments and read-only share links', {
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
  let disabled: Awaited<ReturnType<typeof buildApp>> | undefined;
  let attachmentRoot: string | undefined;
  const sockets: WebSocket[] = [];
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(sourceUrl);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 8, connectionTimeoutMillis: 5000 });
    const db = pool;
    await runMigrations(pool);
    attachmentRoot = await mkdtemp(join(tmpdir(), 'nbase-collab-'));
    const owner = await initializeOwner(pool, 'owner', await hashPassword(ownerPassword), '协作测试');
    let hub: LiveHub | undefined;
    const options = (shareLinks: boolean) => ({ auth: { repository: new PgAuthRepository(db), publicOrigin: origin },
      pages: new PgPageRepository(db), attachments: new PgAttachmentRepository(db, attachmentRoot!), notesPool: db,
      calendar: { scheduler: false }, shareLinks, onLive: (live: LiveHub) => { hub ??= live; } });
    app = await buildApp(options(true));
    const server = app;
    await server.ready();
    const base = `/api/workspaces/${owner.workspaceId}`;
    let ip = 10;
    type Session = { cookie: string; csrf: string; userId: string };
    const login = async (loginName: string, password: string): Promise<Session> => {
      const response = await server.inject({ method: 'POST', url: '/api/auth/login', headers: { origin },
        payload: { loginName, password }, remoteAddress: `192.0.2.${ip++}` });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json() as AuthSessionResponse;
      return { cookie: String(response.headers['set-cookie']).split(';', 1)[0]!, csrf: body.csrfToken, userId: body.user.id };
    };
    const call = (session: Session, method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, payload?: unknown) =>
      server.inject({ method, url: `${base}${path}`, headers: method === 'GET' ? { cookie: session.cookie }
        : { cookie: session.cookie, origin, 'x-csrf-token': session.csrf }, ...(method === 'GET' ? {} : { payload: (payload ?? {}) as object }) });
    const ownerSession = await login('owner', ownerPassword);
    const joinAs = async (role: 'editor' | 'viewer', loginName: string) => {
      const invitation = await call(ownerSession, 'POST', '/invitations', { role });
      assert.equal(invitation.statusCode, 201, invitation.body);
      const accepted = await server.inject({ method: 'POST', url: '/api/invitations/accept', headers: { origin },
        payload: { token: invitation.json<CreateInvitationResponse>().token, loginName, password: memberPassword } });
      assert.equal(accepted.statusCode, 201, accepted.body);
      return login(loginName, memberPassword);
    };
    const editor = await joinAs('editor', 'editor');
    const viewer = await joinAs('viewer', 'viewer');

    const attachmentId = randomUUID();
    const unreferenced = randomUUID();
    for (const id of [attachmentId, unreferenced]) {
      const upload = await server.inject({ method: 'PUT', url: `${base}/attachments/${id}?name=dot.png`, headers: {
        cookie: ownerSession.cookie, origin, 'x-csrf-token': ownerSession.csrf, 'content-type': 'application/octet-stream' }, payload: png });
      assert.equal(upload.statusCode, 201, upload.body);
    }
    const create = async (title: string, parentId: string | null, content: unknown = doc(title)) => {
      const response = await call(ownerSession, 'POST', '/pages', { clientMutationId: randomUUID(), parentId, title, content });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<PageDocument>();
    };
    const root = await create('分享根页', null, doc('根页正文', [attachmentNode(attachmentId)]));
    const child = await create('子页面', root.id);
    const grandchild = await create('孙页面', child.id);
    const database = await call(ownerSession, 'POST', '/databases', { clientMutationId: randomUUID(), parentId: root.id, title: '表格' });
    assert.equal(database.statusCode, 201, database.body);
    const other = await create('范围外', null);

    // --- Last editor ---------------------------------------------------------------------------------------
    const read = async (session: Session, pageId: string) => (await call(session, 'GET', `/pages/${pageId}`)).json<PageDocument>();
    assert.deepEqual((await read(viewer, root.id)).lastEditor, { userId: ownerSession.userId, loginName: 'owner' });

    // --- Live channel --------------------------------------------------------------------------------------
    const messages = new Map<WebSocket, LiveServerMessage[]>();
    const connect = async (session: Session, headers: Record<string, string> = { origin }) => {
      const list: LiveServerMessage[] = [];
      // Listen from the start: the server greets before the client sees the open event.
      const socket = await server.injectWS(`${base}/live`, { headers: { cookie: session.cookie, ...headers } },
        { onInit: ws => ws.on('message', data => list.push(JSON.parse(data.toString()) as LiveServerMessage)) });
      sockets.push(socket);
      messages.set(socket, list);
      return socket;
    };
    const waitFor = async (socket: WebSocket, test: (message: LiveServerMessage) => boolean) => {
      for (let i = 0; i < 100; i++) {
        const found = messages.get(socket)!.find(test);
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail(`no matching message: ${JSON.stringify(messages.get(socket))}`);
    };
    await assert.rejects(connect(editor, { origin: 'http://elsewhere.test' }), /403/);
    await assert.rejects(connect(editor, {}), /403/);
    await assert.rejects(server.injectWS(`${base}/live`, { headers: { origin } }), /401/);
    const plain = await server.inject({ method: 'GET', url: `${base}/live`, headers: { cookie: editor.cookie, origin } });
    assert.equal(plain.statusCode, 426);

    const editorSocket = await connect(editor);
    const viewerSocket = await connect(viewer);
    await waitFor(editorSocket, m => m.t === 'hello');
    editorSocket.send(JSON.stringify({ t: 'focus', pageId: root.id, editing: true }));
    // A viewer can never be shown as editing.
    viewerSocket.send(JSON.stringify({ t: 'focus', pageId: root.id, editing: true }));
    const presence = await waitFor(editorSocket, m => m.t === 'presence' && m.members.length === 2);
    assert.ok(presence.t === 'presence');
    assert.deepEqual(presence.members, [
      { userId: editor.userId, loginName: 'editor', editing: true }, { userId: viewer.userId, loginName: 'viewer', editing: false }]);
    viewerSocket.send('not json');
    viewerSocket.send(JSON.stringify({ t: 'ping' }));
    await waitFor(viewerSocket, m => m.t === 'pong');

    const saved = await call(editor, 'PATCH', `/pages/${root.id}`, { clientMutationId: randomUUID(), expectedRevision: root.revision,
      content: doc('编辑者改过', [attachmentNode(attachmentId)]) });
    assert.equal(saved.statusCode, 200, saved.body);
    const notice = await waitFor(viewerSocket, m => m.t === 'saved');
    assert.deepEqual(notice, { t: 'saved', pageId: root.id, revision: saved.json<PageDocument>().revision,
      by: { userId: editor.userId, loginName: 'editor' } });
    assert.deepEqual((await read(viewer, root.id)).lastEditor, { userId: editor.userId, loginName: 'editor' });

    viewerSocket.send(JSON.stringify({ t: 'focus', pageId: null, editing: false }));
    await waitFor(editorSocket, m => m.t === 'presence' && m.members.length === 1);

    // --- Comments ------------------------------------------------------------------------------------------
    const threadId = randomUUID();
    const firstComment = randomUUID();
    const anchor = { blockId: null, path: [0], quote: '编辑者改过' };
    viewerSocket.send(JSON.stringify({ t: 'focus', pageId: root.id, editing: false }));
    await waitFor(editorSocket, m => m.t === 'presence' && m.members.length === 2 && messages.get(editorSocket)!.filter(x => x.t === 'presence').length >= 3);
    const opened = await call(viewer, 'POST', `/pages/${root.id}/comments`, { id: threadId, commentId: firstComment, anchor, body: '  只读成员提问  ' });
    assert.equal(opened.statusCode, 201, opened.body);
    assert.equal(opened.json<CommentThread>().comments[0]!.body, '只读成员提问');
    await waitFor(editorSocket, m => m.t === 'comments' && m.pageId === root.id);
    const retried = await call(viewer, 'POST', `/pages/${root.id}/comments`, { id: threadId, commentId: firstComment, anchor, body: '只读成员提问' });
    assert.equal(retried.statusCode, 200);
    assert.equal((await call(editor, 'POST', `/pages/${root.id}/comments`, { id: threadId, commentId: randomUUID(), anchor, body: 'x' })).statusCode, 409);
    assert.equal((await call(viewer, 'POST', `/pages/${root.id}/comments`, { id: randomUUID(), commentId: randomUUID(), anchor, body: '   ' })).statusCode, 400);
    assert.equal((await call(viewer, 'POST', `/pages/${root.id}/comments`, { id: randomUUID(), commentId: randomUUID(),
      anchor: { blockId: 'BAD', path: [0], quote: '' }, body: 'x' })).statusCode, 400);
    assert.equal((await call(viewer, 'POST', `/pages/${database.json().page.id}/comments`, { id: randomUUID(), commentId: randomUUID(), anchor, body: 'x' })).statusCode, 422);

    const replyId = randomUUID();
    const replied = await call(editor, 'POST', `/comment-threads/${threadId}/replies`, { id: replyId, body: '编辑者回复' });
    assert.equal(replied.statusCode, 201, replied.body);
    assert.equal((await call(viewer, 'PATCH', `/comments/${replyId}`, { body: '冒改' })).statusCode, 403);
    assert.equal((await call(viewer, 'POST', `/comments/${replyId}/delete`)).statusCode, 403);
    const edited = await call(viewer, 'PATCH', `/comments/${firstComment}`, { body: '只读成员改过' });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.ok(edited.json<CommentThread>().comments[0]!.editedAt);
    assert.equal((await call(viewer, 'POST', `/comment-threads/${threadId}/resolve`)).statusCode, 403);
    const resolved = await call(editor, 'POST', `/comment-threads/${threadId}/resolve`);
    assert.equal(resolved.json<CommentThread>().resolvedBy?.loginName, 'editor');
    assert.equal((await call(editor, 'POST', `/comment-threads/${threadId}/resolve`)).json<CommentThread>().resolvedAt, resolved.json<CommentThread>().resolvedAt);
    assert.equal((await call(ownerSession, 'POST', `/comment-threads/${threadId}/reopen`)).json<CommentThread>().resolvedAt, null);
    // The owner may delete anyone's comment.
    const removed = await call(ownerSession, 'POST', `/comments/${replyId}/delete`);
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(removed.json<CommentThread>().comments.map(item => item.id), [firstComment]);
    assert.equal((await call(ownerSession, 'POST', `/comments/${replyId}/delete`)).statusCode, 200);
    assert.equal((await call(editor, 'PATCH', `/comments/${replyId}`, { body: 'x' })).statusCode, 404);
    const list = await call(viewer, 'GET', `/pages/${root.id}/comments`);
    assert.equal(list.json<CommentThreadListResponse>().threads.length, 1);
    // Comments change neither the page nor its revision or history.
    const afterComments = await read(editor, root.id);
    assert.equal(afterComments.revision, saved.json<PageDocument>().revision);
    // A thread whose comments are all deleted disappears from the list.
    const lone = randomUUID();
    const loneComment = randomUUID();
    assert.equal((await call(editor, 'POST', `/pages/${child.id}/comments`, { id: lone, commentId: loneComment, anchor, body: '单条' })).statusCode, 201);
    assert.equal((await call(editor, 'POST', `/comments/${loneComment}/delete`)).statusCode, 200);
    assert.equal((await call(editor, 'GET', `/pages/${child.id}/comments`)).json<CommentThreadListResponse>().threads.length, 0);

    // --- Share links ---------------------------------------------------------------------------------------
    assert.equal((await call(viewer, 'GET', `/pages/${root.id}/shares`)).statusCode, 403);
    assert.equal((await call(viewer, 'POST', `/pages/${root.id}/shares`, { includeChildren: true, expiresInDays: 7 })).statusCode, 403);
    assert.equal((await call(editor, 'POST', `/pages/${root.id}/shares`, { includeChildren: true, expiresInDays: 3 })).statusCode, 400);
    assert.equal((await call(editor, 'POST', `/pages/${database.json().page.id}/shares`, { includeChildren: false })).statusCode, 422);
    const shared = await call(editor, 'POST', `/pages/${root.id}/shares`, { includeChildren: true, expiresInDays: 1 });
    assert.equal(shared.statusCode, 201, shared.body);
    const { share, token, url: link } = shared.json<CreatePageShareResponse>();
    assert.equal(link, `${origin}/#share=${share.id}.${token}`);
    assert.equal(share.status, 'active');
    assert.ok(Math.abs(Date.parse(share.expiresAt) - Date.parse(share.createdAt) - 86400000) < 1000);
    const stored = await db.query<{ token_hash: Buffer }>('SELECT token_hash FROM page_share_links WHERE id = $1', [share.id]);
    assert.deepEqual(stored.rows[0]!.token_hash, createHash('sha256').update(Buffer.from(token, 'base64url')).digest());
    assert.ok(!JSON.stringify((await db.query('SELECT * FROM page_share_links')).rows).includes(token));

    const open = (path: string, headers: Record<string, string> = { 'x-nbase-share': token }, remoteAddress = '192.168.1.20') =>
      server.inject({ method: 'GET', url: `/api/shared/${share.id}${path}`, headers, remoteAddress });
    const rootView = await open('');
    assert.equal(rootView.statusCode, 200, rootView.body);
    assert.equal(rootView.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(rootView.headers['referrer-policy'], 'no-referrer');
    assert.equal(rootView.headers['cache-control'], 'no-store');
    const cookie = String(rootView.headers['set-cookie']);
    assert.match(cookie, new RegExp(`^nbase_share=${token}; Path=/api/shared/${share.id}/; HttpOnly; SameSite=Strict; Max-Age=\\d+$`));
    const scope = rootView.json<SharedRootResponse>();
    assert.equal(scope.rootPageId, root.id);
    assert.deepEqual(scope.pages.map(item => item.title), ['分享根页', '子页面', '孙页面'], 'databases and pages outside stay out');
    assert.equal(scope.pages[0]!.parentId, null);
    const page = await open(`/pages/${grandchild.id}`);
    assert.equal(page.json<SharedPageResponse>().title, '孙页面');
    assert.ok(page.json<SharedPageResponse>().content);
    assert.equal((await open(`/pages/${other.id}`)).statusCode, 404);
    assert.equal((await open(`/pages/${database.json().page.id}`)).statusCode, 404);
    const shareCookie = { cookie: `nbase_share=${token}` };
    const image = await open(`/attachments/${attachmentId}`, shareCookie);
    assert.equal(image.statusCode, 200, image.body);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.deepEqual(image.rawPayload, png);
    const ranged = await server.inject({ method: 'GET', url: `/api/shared/${share.id}/attachments/${attachmentId}`,
      headers: { ...shareCookie, range: 'bytes=0-7' }, remoteAddress: '10.0.0.5' });
    assert.equal(ranged.statusCode, 206);
    assert.equal(ranged.rawPayload.length, 8);
    assert.equal((await open(`/attachments/${unreferenced}`, shareCookie)).statusCode, 404, 'only referenced attachments');
    // The page JSON needs the header; the cookie is only for media.
    assert.equal((await open(`/pages/${root.id}`, shareCookie)).statusCode, 404);
    // Only loopback, private and link-local addresses.
    assert.equal((await open('', { 'x-nbase-share': token }, '203.0.113.9')).statusCode, 404);
    assert.equal((await open('', { 'x-nbase-share': token }, '::1')).statusCode, 200);
    assert.equal((await open('', { 'x-nbase-share': token, origin: 'http://elsewhere.test' })).statusCode, 403);
    assert.ok(isLocalNetworkAddress('::ffff:192.168.0.1') && isLocalNetworkAddress('fe80::1') && isLocalNetworkAddress('fd00::1'));
    assert.ok(!isLocalNetworkAddress('8.8.8.8') && !isLocalNetworkAddress('100.64.0.1') && !isLocalNetworkAddress('2001:db8::1'));

    // Wrong tokens count against the address.
    for (let i = 0; i < 10; i++) assert.equal((await open('', { 'x-nbase-share': 'a'.repeat(43) }, '192.168.9.9')).statusCode, 404);
    assert.equal((await open('', { 'x-nbase-share': token }, '192.168.9.9')).statusCode, 429);

    const listed = (await call(editor, 'GET', `/pages/${root.id}/shares`)).json<PageShareListResponse>();
    assert.equal(listed.enabled, true);
    assert.equal(listed.shares[0]!.viewCount, 2, 'opening the root counts; refused requests do not');
    assert.ok(!JSON.stringify(listed).includes(token));

    // A root page in the trash, a revoked link and an expired link all end the share.
    const narrow = (await call(editor, 'POST', `/pages/${root.id}/shares`, { includeChildren: false, expiresInDays: 30 })).json<CreatePageShareResponse>();
    const narrowView = await server.inject({ method: 'GET', url: `/api/shared/${narrow.share.id}`, headers: { 'x-nbase-share': narrow.token } });
    assert.deepEqual(narrowView.json<SharedRootResponse>().pages.map(item => item.id), [root.id]);
    assert.equal((await server.inject({ method: 'GET', url: `/api/shared/${narrow.share.id}/pages/${child.id}`,
      headers: { 'x-nbase-share': narrow.token } })).statusCode, 404);
    const revoked = await call(editor, 'POST', `/shares/${narrow.share.id}/revoke`);
    assert.equal(revoked.json().status, 'revoked');
    assert.equal((await call(editor, 'POST', `/shares/${narrow.share.id}/revoke`)).statusCode, 200);
    assert.equal((await server.inject({ method: 'GET', url: `/api/shared/${narrow.share.id}`, headers: { 'x-nbase-share': narrow.token } })).statusCode, 410);
    await db.query(`UPDATE page_share_links SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second' WHERE id = $1`, [share.id]);
    assert.equal((await open('')).statusCode, 410);
    assert.equal((await call(editor, 'GET', `/pages/${root.id}/shares`)).json<PageShareListResponse>().shares
      .find(item => item.id === share.id)!.status, 'expired');

    // At most 20 active links per page.
    for (let i = 0; i < 20; i++) assert.equal((await call(editor, 'POST', `/pages/${child.id}/shares`, { includeChildren: false })).statusCode, 201);
    assert.equal((await call(editor, 'POST', `/pages/${child.id}/shares`, { includeChildren: false })).json().error, 'SHARE_LIMIT');

    // NBASE_SHARE_LINKS=off: links can still be listed and revoked, but not created or opened.
    disabled = await buildApp(options(false));
    const off = await disabled.inject({ method: 'GET', url: `${base}/pages/${child.id}/shares`, headers: { cookie: editor.cookie } });
    assert.equal(off.json<PageShareListResponse>().enabled, false);
    assert.equal((await disabled.inject({ method: 'POST', url: `${base}/pages/${child.id}/shares`, headers: { cookie: editor.cookie, origin,
      'x-csrf-token': editor.csrf }, payload: { includeChildren: false } })).json().error, 'SHARE_DISABLED');
    const anyLink = off.json<PageShareListResponse>().shares[0]!;
    assert.equal((await disabled.inject({ method: 'GET', url: `/api/shared/${anyLink.id}`, headers: { 'x-nbase-share': token } })).statusCode, 404);

    // --- Membership changes end live connections ------------------------------------------------------------
    await call(ownerSession, 'PATCH', `/members/${viewer.userId}`, { role: 'editor' });
    assert.equal(hub!.size, 2);
    await hub!.recheck();
    // The injected test socket never sees the end of the stream, so check the close frame it received
    // and that the server let go of the connection.
    for (let i = 0; i < 200 && hub!.size > 1; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(hub!.size, 1);
    assert.ok(viewerSocket.readyState === viewerSocket.CLOSING || viewerSocket.readyState === viewerSocket.CLOSED);
    assert.equal((viewerSocket as unknown as { _closeCode: number })._closeCode, liveCloseAuth);
    assert.equal(editorSocket.readyState, editorSocket.OPEN);
  } finally {
    // Both ends, or ws's close timeouts keep the process alive for another 30 seconds.
    for (const socket of sockets) socket.terminate();
    for (const client of app?.websocketServer.clients ?? []) client.terminate();
    await disabled?.close();
    await app?.close();
    await pool?.end();
    if (attachmentRoot) await rm(attachmentRoot, { recursive: true, force: true });
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
});
