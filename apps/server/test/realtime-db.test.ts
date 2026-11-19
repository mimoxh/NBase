import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { AuthSessionResponse, CreateInvitationResponse, LiveServerMessage, PageDocument, RoomFrame } from '@nbase/contracts';
import { bytesToBase64, decodeRoomFrame, encodeRoomFrame, roomFrameKinds } from '@nbase/contracts';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
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
const doc = (text: string) => ({ schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [
  { type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text }] }] } } });

type Session = { cookie: string; csrf: string; userId: string };

/** A test client: one socket, one Y.Doc per joined room, like the web client. */
class Peer {
  readonly json: LiveServerMessage[] = [];
  readonly frames: RoomFrame[] = [];
  readonly doc = new Y.Doc();
  epoch = 0;
  constructor(readonly socket: WebSocket, readonly pageId: string) {}

  async waitJson<T extends LiveServerMessage>(test: (message: LiveServerMessage) => message is T, from?: number): Promise<T>;
  async waitJson(test: (message: LiveServerMessage) => boolean, from?: number): Promise<LiveServerMessage>;
  async waitJson(test: (message: LiveServerMessage) => boolean, from = 0): Promise<LiveServerMessage> {
    for (let i = 0; i < 150; i++) {
      const found = this.json.slice(from).find(test);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`no matching message: ${JSON.stringify(this.json)}`);
  }

  async waitFrame(kind: number, from = 0): Promise<RoomFrame> {
    for (let i = 0; i < 150; i++) {
      const found = this.frames.slice(from).find(frame => frame.kind === kind);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`no frame of kind ${kind}`);
  }

  send(kind: RoomFrame['kind'], payload: Uint8Array, epoch = this.epoch): void {
    this.socket.send(encodeRoomFrame({ kind, pageId: this.pageId, epoch, payload }));
  }

  /** Applies every update frame received so far for the current epoch. */
  applyReceived(): void {
    for (const frame of this.frames.splice(0)) {
      if (frame.kind === roomFrameKinds.update && frame.epoch === this.epoch) Y.applyUpdate(this.doc, frame.payload, 'remote');
    }
  }

  edit(change: (doc: Y.Doc) => void): Uint8Array {
    let update: Uint8Array | null = null;
    const capture = (value: Uint8Array) => { update = value; };
    this.doc.once('update', capture);
    this.doc.transact(() => change(this.doc));
    assert.ok(update);
    return update;
  }

  stateVector(): string { return bytesToBase64(Y.encodeStateVector(this.doc)); }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 150));

test('real-time rooms store, relay, save, reset on outside writes and survive a restart', {
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
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const sockets: WebSocket[] = [];
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(sourceUrl);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 10, connectionTimeoutMillis: 5000 });
    const db = pool;
    await runMigrations(db);
    const owner = await initializeOwner(db, 'owner', await hashPassword(ownerPassword), '协同测试');
    const start = async () => {
      const app = await buildApp({ auth: { repository: new PgAuthRepository(db), publicOrigin: origin }, pages: new PgPageRepository(db),
        notesPool: db, calendar: { scheduler: false } });
      await app.ready();
      apps.push(app);
      return app;
    };
    let server = await start();
    const base = `/api/workspaces/${owner.workspaceId}`;
    let ip = 10;
    const login = async (loginName: string, password: string): Promise<Session> => {
      const response = await server.inject({ method: 'POST', url: '/api/auth/login', headers: { origin },
        payload: { loginName, password }, remoteAddress: `192.0.2.${ip++}` });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json() as AuthSessionResponse;
      return { cookie: String(response.headers['set-cookie']).split(';', 1)[0]!, csrf: body.csrfToken, userId: body.user.id };
    };
    const call = (session: Session, method: 'GET' | 'POST' | 'PATCH', path: string, payload?: unknown) =>
      server.inject({ method, url: `${base}${path}`, headers: method === 'GET' ? { cookie: session.cookie }
        : { cookie: session.cookie, origin, 'x-csrf-token': session.csrf }, ...(method === 'GET' ? {} : { payload: (payload ?? {}) as object }) });
    const ownerSession = await login('owner', ownerPassword);
    const joinAs = async (role: 'editor' | 'viewer', loginName: string) => {
      const invitation = await call(ownerSession, 'POST', '/invitations', { role });
      const accepted = await server.inject({ method: 'POST', url: '/api/invitations/accept', headers: { origin },
        payload: { token: invitation.json<CreateInvitationResponse>().token, loginName, password: memberPassword } });
      assert.equal(accepted.statusCode, 201, accepted.body);
      return login(loginName, memberPassword);
    };
    const editor = await joinAs('editor', 'editor');
    const viewer = await joinAs('viewer', 'viewer');
    const created1 = await call(ownerSession, 'POST', '/pages', { clientMutationId: randomUUID(), parentId: null, title: '协同页', content: doc('初始') });
    assert.equal(created1.statusCode, 201, created1.body);
    const page = created1.json<PageDocument>();

    const connect = async (session: Session, pageId = page.id) => {
      let peer: Peer | undefined;
      const pending: [Buffer, boolean][] = [];
      const socket = await server.injectWS(`${base}/live`, { headers: { cookie: session.cookie, origin } }, {
        onInit: ws => ws.on('message', (data: Buffer, isBinary: boolean) => {
          if (!peer) { pending.push([data, isBinary]); return; }
          receive(peer, data, isBinary);
        }) });
      sockets.push(socket);
      peer = new Peer(socket, pageId);
      for (const [data, isBinary] of pending.splice(0)) receive(peer, data, isBinary);
      return peer;
    };
    const receive = (peer: Peer, data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        const message = JSON.parse(data.toString()) as LiveServerMessage;
        peer.json.push(message);
        if ((message.t === 'room' || message.t === 'roomRole') && message.pageId === peer.pageId) peer.epoch = message.epoch;
        return;
      }
      const frame = decodeRoomFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      if (frame) peer.frames.push({ ...frame, payload: frame.payload.slice() });
    };
    const join = async (peer: Peer) => {
      const from = peer.json.length;
      peer.socket.send(JSON.stringify({ t: 'join', pageId: peer.pageId }));
      const room = await peer.waitJson((m): m is Extract<LiveServerMessage, { t: 'room' }> => m.t === 'room' && m.pageId === peer.pageId, from);
      peer.epoch = room.epoch;
      return room;
    };
    const sync = async (peer: Peer) => {
      const from = peer.frames.length;
      peer.send(roomFrameKinds.state, Y.encodeStateVector(peer.doc));
      await peer.waitFrame(roomFrameKinds.update, from);
      peer.applyReceived();
    };
    const rows = async (table: 'page_collab_updates' | 'page_collab_rooms') =>
      Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE page_id = $1`, [page.id])).rows[0]!.n);

    // --- Roles: the first editor seeds and saves; viewers never do. ---------------------------------------
    const a = await connect(ownerSession);
    const b = await connect(editor);
    const v = await connect(viewer);
    const roomA = await join(a);
    assert.equal(roomA.seed, true);
    assert.equal(roomA.saver, true);
    assert.equal(roomA.baseRevision, page.revision);
    const roomB = await join(b);
    assert.equal(roomB.seed, false);
    assert.equal(roomB.saver, false);
    assert.equal(roomB.epoch, roomA.epoch);
    const roomV = await join(v);
    assert.equal(roomV.readOnly, true);
    assert.equal(roomV.saver, false);

    // --- Seed, relay, acknowledgement. ---------------------------------------------------------------------
    const seed = a.edit(doc => { doc.getText('title').insert(0, '协同页'); doc.getText('body').insert(0, '初始'); });
    const ackFrom = a.frames.length;
    a.send(roomFrameKinds.update, seed);
    const ack = await a.waitFrame(roomFrameKinds.ack, ackFrom);
    assert.equal(Y.decodeStateVector(ack.payload).get(a.doc.clientID), Y.decodeStateVector(Y.encodeStateVector(a.doc)).get(a.doc.clientID));
    await b.waitFrame(roomFrameKinds.update);
    b.applyReceived();
    assert.equal(b.doc.getText('body').toString(), '初始');
    assert.equal(await rows('page_collab_updates'), 1);

    const edit = b.edit(doc => doc.getText('body').insert(2, '，乙补充'));
    const relayed = a.frames.length;
    b.send(roomFrameKinds.update, edit);
    await a.waitFrame(roomFrameKinds.update, relayed);
    a.applyReceived();
    assert.equal(a.doc.getText('body').toString(), '初始，乙补充');

    // A viewer's document updates are dropped, never stored or relayed.
    await sync(v);
    assert.equal(v.doc.getText('body').toString(), '初始，乙补充');
    const forged = v.edit(doc => doc.getText('body').insert(0, '只读'));
    v.send(roomFrameKinds.update, forged);
    await settle();
    assert.equal(await rows('page_collab_updates'), 2);
    assert.ok(!a.frames.some(frame => frame.kind === roomFrameKinds.update));
    // Frames for another epoch are ignored.
    b.send(roomFrameKinds.update, b.edit(doc => doc.getText('body').insert(0, '旧代')), roomA.epoch === 1 ? 2 : roomA.epoch - 1);
    await settle();
    assert.equal(await rows('page_collab_updates'), 2);
    b.doc.getText('body').delete(0, 2);

    // --- Saver writes revisions; stale and wrong-epoch saves are refused. ----------------------------------
    const save = (session: Session, peer: Peer, text: string, expectedRevision: string, collab: unknown) => call(session, 'PATCH',
      `/pages/${page.id}`, { clientMutationId: randomUUID(), expectedRevision, content: doc(text), collab });
    const first = await save(ownerSession, a, '初始，乙补充', page.revision, { epoch: a.epoch, stateVector: a.stateVector() });
    assert.equal(first.statusCode, 200, first.body);
    const firstRevision = first.json<PageDocument>().revision;
    const savedB = await b.waitJson((m): m is Extract<LiveServerMessage, { t: 'roomSaved' }> => m.t === 'roomSaved');
    assert.equal(savedB.revision, firstRevision);
    assert.deepEqual(savedB.by, { userId: ownerSession.userId, loginName: 'owner' });
    assert.equal((await save(editor, b, '旧内容', page.revision, { epoch: b.epoch, stateVector: bytesToBase64(new Uint8Array([0])) })).statusCode, 409);
    const wrongEpoch = await save(editor, b, '旧内容', firstRevision, { epoch: b.epoch === 1 ? 2 : b.epoch - 1, stateVector: b.stateVector() });
    assert.equal(wrongEpoch.statusCode, 409);
    assert.equal(wrongEpoch.json<{ error: string }>().error, 'COLLAB_EPOCH');
    assert.equal((await save(editor, b, '旧内容', firstRevision, { epoch: b.epoch, stateVector: 'not base64!' })).statusCode, 400);
    // A saver cannot claim clocks the server never received.
    const ahead = new Y.Doc();
    Y.applyUpdate(ahead, Y.encodeStateAsUpdate(b.doc));
    ahead.getText('body').insert(0, '未发送');
    const claimed = await save(editor, b, '初始，乙补充', firstRevision, { epoch: b.epoch, stateVector: bytesToBase64(
      Y.encodeStateVector(ahead)) });
    assert.equal(claimed.statusCode, 200, claimed.body);
    const stored = await db.query<{ saved_state_vector: Buffer }>('SELECT saved_state_vector FROM page_collab_rooms WHERE page_id = $1', [page.id]);
    assert.equal(Y.decodeStateVector(stored.rows[0]!.saved_state_vector).get(ahead.clientID) ?? 0, 0);

    // --- A title-only write outside the room becomes a room edit, the room keeps its epoch. -----------------
    const current = (await call(ownerSession, 'GET', `/pages/${page.id}`)).json<PageDocument>();
    const titleFrom = b.frames.length;
    const renamed = await call(ownerSession, 'PATCH', `/pages/${page.id}`, { clientMutationId: randomUUID(),
      expectedRevision: current.revision, title: '改过的标题' });
    assert.equal(renamed.statusCode, 200, renamed.body);
    await b.waitFrame(roomFrameKinds.update, titleFrom);
    b.applyReceived();
    assert.equal(b.doc.getText('title').toString(), '改过的标题');
    assert.ok(!b.json.some(m => m.t === 'roomReset'));
    // The saver writes on top of the rename without knowing its revision.
    const afterRename = await save(ownerSession, a, '初始，乙补充。', current.revision, { epoch: a.epoch, stateVector: a.stateVector() });
    assert.equal(afterRename.statusCode, 200, afterRename.body);
    assert.equal(afterRename.json<PageDocument>().title, '改过的标题');

    // --- Restart: the room comes back from storage with the same epoch and content. ------------------------
    const epochBefore = a.epoch;
    for (const socket of sockets.splice(0)) socket.terminate();
    await settle();
    await server.close();
    server = await start();
    const b2 = await connect(editor);
    const again = await join(b2);
    assert.equal(again.epoch, epochBefore);
    assert.equal(again.saver, true);
    assert.equal(again.seed, false);
    await sync(b2);
    assert.equal(b2.doc.getText('body').toString(), '初始，乙补充');
    assert.equal(b2.doc.getText('title').toString(), '改过的标题');

    // --- Outside content writes start the room again. -------------------------------------------------------
    const v2 = await connect(viewer);
    await join(v2);
    const latest = (await call(ownerSession, 'GET', `/pages/${page.id}`)).json<PageDocument>();
    const resetFrom = b2.json.length;
    const outside = await call(ownerSession, 'PATCH', `/pages/${page.id}`, { clientMutationId: randomUUID(),
      expectedRevision: latest.revision, content: doc('外部写入') });
    assert.equal(outside.statusCode, 200, outside.body);
    const reset = await b2.waitJson((m): m is Extract<LiveServerMessage, { t: 'roomReset' }> => m.t === 'roomReset', resetFrom);
    assert.notEqual(reset.epoch, epochBefore);
    assert.equal(reset.reason, 'write');
    assert.equal(reset.revision, outside.json<PageDocument>().revision);
    assert.deepEqual(reset.by, { userId: ownerSession.userId, loginName: 'owner' });
    const rejoined = await b2.waitJson((m): m is Extract<LiveServerMessage, { t: 'room' }> => m.t === 'room' && m.epoch === reset.epoch, resetFrom);
    assert.equal(rejoined.seed, true);
    assert.equal(rejoined.baseRevision, reset.revision);
    await v2.waitJson(m => m.t === 'roomReset');
    assert.equal(await rows('page_collab_updates'), 0);

    // History restore is reported as such.
    const history = await call(ownerSession, 'GET', `/pages/${page.id}/history`);
    assert.equal(history.statusCode, 200, history.body);
    const versions = history.json<{ versions: { revision: string }[] }>().versions;
    const now = (await call(ownerSession, 'GET', `/pages/${page.id}`)).json<PageDocument>();
    const restoreFrom = b2.json.length;
    const restored = await call(ownerSession, 'POST', `/pages/${page.id}/restore-version`,
      { clientMutationId: randomUUID(), expectedRevision: now.revision, sourceRevision: versions.at(-1)!.revision });
    assert.equal(restored.statusCode, 200, restored.body);
    const restoreReset = await b2.waitJson((m): m is Extract<LiveServerMessage, { t: 'roomReset' }> => m.t === 'roomReset', restoreFrom);
    assert.equal(restoreReset.reason, 'restore');
    await b2.waitJson(m => m.t === 'room' && m.epoch === restoreReset.epoch, restoreFrom);

    // --- Saver hand-over and the trash. ---------------------------------------------------------------------
    const c = await connect(ownerSession);
    const roomC = await join(c);
    assert.equal(roomC.saver, false);
    const handFrom = c.json.length;
    b2.socket.terminate();
    const role = await c.waitJson((m): m is Extract<LiveServerMessage, { t: 'roomRole' }> => m.t === 'roomRole', handFrom);
    assert.equal(role.saver, true);
    const live = (await call(ownerSession, 'GET', `/pages/${page.id}`)).json<PageDocument>();
    const trashFrom = c.json.length;
    const trashed = await call(ownerSession, 'POST', `/pages/${page.id}/trash`, { clientMutationId: randomUUID(), expectedRevision: live.revision });
    assert.equal(trashed.statusCode, 200, trashed.body);
    const closed = await c.waitJson(m => m.t === 'roomError', trashFrom);
    assert.deepEqual(closed, { t: 'roomError', pageId: page.id, code: 'NOT_FOUND' });
    assert.equal(await rows('page_collab_rooms'), 0);
    const late = await connect(editor);
    late.socket.send(JSON.stringify({ t: 'join', pageId: page.id }));
    assert.deepEqual(await late.waitJson(m => m.t === 'roomError'), { t: 'roomError', pageId: page.id, code: 'NOT_FOUND' });
  } finally {
    for (const socket of sockets) socket.terminate();
    for (const app of apps) await app.close().catch(() => undefined);
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
});
