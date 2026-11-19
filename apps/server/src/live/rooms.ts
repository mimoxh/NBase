import type { CollabWrite, MemberRef, RoomErrorCode, RoomFrame, RoomResetReason, RoomServerMessage } from '@nbase/contracts';
import { base64ToBytes, bytesToBase64, collabStateVectorLimit, encodeRoomFrame, roomFrameKinds } from '@nbase/contracts';
import { randomInt } from 'node:crypto';
import pg, { type Pool, type PoolClient } from 'pg';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';

/** One open WebSocket as the rooms see it. */
export interface RoomPeer {
  readonly workspaceId: string;
  readonly userId: string;
  readonly loginName: string;
  readonly role: string;
  sendJson(message: RoomServerMessage): void;
  sendBinary(bytes: Uint8Array): void;
}

interface RoomRow {
  epoch: string; base_revision: string; saved_revision: string | null; saved_state_vector: Buffer | null;
  snapshot: Buffer | null; snapshot_seq: string;
}

const roomKinds = new Set(['document', 'row', 'whiteboard']);
const unloadAfterMs = 60_000;
const compactAfterUpdates = 200;
const compactAfterBytes = 1024 * 1024;
/** Above this the room is rebuilt from the latest revision instead of growing further. */
const roomStateByteLimit = 8 * 1024 * 1024;

export function newEpoch(): number { return randomInt(1, 2 ** 32); }

/** True when every clock in `required` is reached by `state`. */
export function stateVectorCovers(state: Map<number, number>, required: Map<number, number>): boolean {
  for (const [client, clock] of required) if ((state.get(client) ?? 0) < clock) return false;
  return true;
}

export class CollabWriteError extends Error {
  constructor(readonly code: 'COLLAB_EPOCH' | 'COLLAB_STALE' | 'COLLAB_INVALID') { super(code); }
}

/**
 * Checks a saver's write inside the page transaction and marks the transaction as the room's own write, so the
 * external-write trigger leaves the room alone. Returns the state vector to record.
 */
export async function checkCollabWrite(client: PoolClient, workspaceId: string, pageId: string,
  write: { epoch: number; stateVector: Uint8Array }, held: Map<number, number> | null): Promise<Uint8Array> {
  const result = await client.query<{ epoch: string; saved_state_vector: Buffer | null }>(
    'SELECT epoch, saved_state_vector FROM page_collab_rooms WHERE workspace_id = $1 AND page_id = $2 FOR UPDATE',
    [workspaceId, pageId]);
  const row = result.rows[0];
  if (!row || Number(row.epoch) !== write.epoch) throw new CollabWriteError('COLLAB_EPOCH');
  let claimed = Y.decodeStateVector(write.stateVector);
  if (held) claimed = new Map([...claimed].map(([id, clock]) => [id, Math.min(clock, held.get(id) ?? 0)]));
  if (row.saved_state_vector && !stateVectorCovers(claimed, Y.decodeStateVector(row.saved_state_vector))) {
    throw new CollabWriteError('COLLAB_STALE');
  }
  await client.query("SELECT set_config('nbase.collab_epoch', $1, true)", [String(write.epoch)]);
  return encodeStateVectorMap(claimed);
}

/** Records a saver's write in the page transaction; the notification reaches the rooms after commit. */
export async function recordCollabWrite(client: PoolClient, workspaceId: string, pageId: string, epoch: number, revision: string,
  stateVector: Uint8Array, actorId: string): Promise<void> {
  await client.query(`UPDATE page_collab_rooms SET saved_revision = $3, saved_state_vector = $4, updated_at = now()
    WHERE workspace_id = $1 AND page_id = $2`, [workspaceId, pageId, revision, Buffer.from(stateVector)]);
  await client.query("SELECT pg_notify('nbase_rooms', $1)", [JSON.stringify({ k: 'saved', w: workspaceId, p: pageId, e: epoch,
    r: revision, sv: bytesToBase64(stateVector), a: actorId })]);
}

/** Decoded `collab` field of a page write, or null when the value is malformed. */
export function parseCollabWrite(value: unknown): { epoch: number; stateVector: Uint8Array } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const data = value as Partial<CollabWrite>;
  if (!Number.isInteger(data.epoch) || data.epoch! < 1 || data.epoch! >= 2 ** 32 || typeof data.stateVector !== 'string'
    || data.stateVector.length > collabStateVectorLimit * 2) return null;
  const bytes = base64ToBytes(data.stateVector);
  if (!bytes || bytes.byteLength > collabStateVectorLimit) return null;
  try { Y.decodeStateVector(bytes); } catch { return null; }
  return { epoch: data.epoch!, stateVector: bytes };
}

class Room {
  readonly doc = new Y.Doc({ gc: true });
  readonly awareness = new Awareness(this.doc);
  /** Join order; the first editor seeds an empty room and saves revisions. */
  readonly peers = new Map<RoomPeer, Set<number>>();
  epoch = 0;
  baseRevision = '0';
  savedRevision: string | null = null;
  savedStateVector: Uint8Array | null = null;
  seeded = false;
  nextSeq = 1;
  pendingUpdates = 0;
  pendingBytes = 0;
  saver: RoomPeer | null = null;
  queue: Promise<unknown> = Promise.resolve();
  unloadTimer: NodeJS.Timeout | undefined;
  loaded: Promise<void> | undefined;

  constructor(readonly workspaceId: string, readonly pageId: string) {
    this.awareness.setLocalState(null);
  }

  /** Runs storage work for this room one step at a time, in arrival order. */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/**
 * Real-time rooms: one Yjs document per open page (docs/architecture/realtime.md). The server never interprets the
 * document; it stores every update before relaying it, answers state requests, relays awareness and picks the seeder
 * and saver. Revisions are still written by the saver through the ordinary page API.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private listener: pg.Client | null = null;
  private closed = false;

  constructor(private readonly pool: Pool, readonly enabled = true,
    private readonly loginName: (userId: string) => Promise<string> = async () => '') {}

  /** Follows room notifications from page writes (they arrive only after the write committed). */
  async listen(): Promise<void> {
    if (!this.enabled || this.closed || this.listener) return;
    let client: pg.Client | null = null;
    try {
      // A dedicated connection: LISTEN holds it for the server's lifetime, which would otherwise take a slot from the pool.
      client = new pg.Client(this.pool.options);
      this.listener = client;
      await client.connect();
      const current = client;
      current.on('notification', message => {
        if (message.channel === 'nbase_rooms' && message.payload) void this.notice(message.payload).catch(() => undefined);
      });
      current.on('error', () => this.relisten(current));
      await current.query('LISTEN nbase_rooms');
      // Notifications sent while no listener was connected are lost; rooms whose epoch moved meanwhile start again.
      await this.resync();
    } catch { this.relisten(client); }
  }

  private relisten(client: pg.Client | null): void {
    if (this.listener === client) this.listener = null;
    void client?.end().catch(() => undefined);
    if (!this.closed) setTimeout(() => { void this.listen(); }, 2000).unref();
  }

  private async resync(): Promise<void> {
    for (const room of [...this.rooms.values()]) {
      if (!room.loaded) continue;
      const result = await this.pool.query<{ epoch: string; base_revision: string }>(
        'SELECT epoch, base_revision FROM page_collab_rooms WHERE workspace_id = $1 AND page_id = $2', [room.workspaceId, room.pageId]);
      const row = result.rows[0];
      if (!row) this.closeRoom(room.workspaceId, room.pageId);
      else if (Number(row.epoch) !== room.epoch) this.reset(room.workspaceId, room.pageId, Number(row.epoch), row.base_revision, 'write', null);
    }
  }

  private async notice(payload: string): Promise<void> {
    const data = JSON.parse(payload) as { k: string; w: string; p: string; e?: number; r?: string; why?: string | null;
      a?: string | null; title?: string; sv?: string };
    const by = async (userId: string | null | undefined): Promise<MemberRef | null> =>
      userId ? { userId, loginName: await this.loginName(userId) } : null;
    if (data.k === 'reset' && data.e && data.r) {
      this.reset(data.w, data.p, data.e, data.r, data.why === 'restore-version' ? 'restore' : 'write', await by(data.a));
    } else if (data.k === 'saved' && data.e && data.r && data.sv) {
      const vector = base64ToBytes(data.sv);
      const actor = await by(data.a);
      if (vector && actor) this.saved(data.w, data.p, data.e, data.r, vector, actor);
    } else if (data.k === 'title' && typeof data.title === 'string') {
      await this.titleChanged(data.w, data.p, data.title);
    } else if (data.k === 'closed') {
      this.closeRoom(data.w, data.p);
    }
  }

  /** The page went to the trash: its room ends and clients fall back to the read-only page. */
  private closeRoom(workspaceId: string, pageId: string): void {
    const room = this.rooms.get(this.key(workspaceId, pageId));
    if (!room) return;
    this.rooms.delete(this.key(workspaceId, pageId));
    clearTimeout(room.unloadTimer);
    for (const peer of room.peers.keys()) peer.sendJson({ t: 'roomError', pageId: room.pageId, code: 'NOT_FOUND' });
    room.awareness.destroy();
    room.doc.destroy();
  }

  private key(workspaceId: string, pageId: string): string { return `${workspaceId.toLowerCase()}:${pageId.toLowerCase()}`; }

  async join(peer: RoomPeer, pageId: string): Promise<void> {
    if (!this.enabled) return peer.sendJson({ t: 'roomError', pageId, code: 'REALTIME_DISABLED' });
    const page = await this.pool.query<{ kind: string; deleted: boolean }>(
      'SELECT kind, deleted_at IS NOT NULL AS deleted FROM pages WHERE workspace_id = $1 AND id = $2', [peer.workspaceId, pageId]);
    const found = page.rows[0];
    if (!found || found.deleted) return peer.sendJson({ t: 'roomError', pageId, code: 'NOT_FOUND' });
    if (!roomKinds.has(found.kind)) return peer.sendJson({ t: 'roomError', pageId, code: 'PAGE_KIND_INVALID' });
    const room = this.room(peer.workspaceId, pageId);
    clearTimeout(room.unloadTimer);
    room.unloadTimer = undefined;
    try { await this.ensureLoaded(room); } catch (error) {
      this.release(room);
      throw error;
    }
    if (!room.peers.has(peer)) room.peers.set(peer, new Set());
    this.assignRoles(room);
    peer.sendJson(this.roomMessage(room, peer));
    const states = [...room.awareness.getStates().keys()];
    if (states.length) this.sendFrame(peer, room, roomFrameKinds.awareness, encodeAwarenessUpdate(room.awareness, states));
  }

  leave(peer: RoomPeer, pageId: string): void {
    const room = this.rooms.get(this.key(peer.workspaceId, pageId));
    if (!room) return;
    const clients = room.peers.get(peer);
    if (!clients) return;
    room.peers.delete(peer);
    if (clients.size) removeAwarenessStates(room.awareness, [...clients], peer);
    this.broadcastAwareness(room, [...clients], peer);
    this.assignRoles(room);
    this.release(room);
  }

  async frame(peer: RoomPeer, frame: RoomFrame): Promise<void> {
    const room = this.rooms.get(this.key(peer.workspaceId, frame.pageId));
    if (!room || !room.peers.has(peer) || room.epoch !== frame.epoch) return;
    if (frame.kind === roomFrameKinds.state) {
      let missing: Uint8Array;
      try { missing = Y.encodeStateAsUpdate(room.doc, frame.payload); } catch { return; }
      this.sendFrame(peer, room, roomFrameKinds.update, missing);
      // Ask back, so the client sends what it wrote while offline.
      this.sendFrame(peer, room, roomFrameKinds.state, Y.encodeStateVector(room.doc));
      return;
    }
    if (frame.kind === roomFrameKinds.awareness) {
      const clients = room.peers.get(peer)!;
      try {
        const before = new Set(room.awareness.getStates().keys());
        applyAwarenessUpdate(room.awareness, frame.payload, peer);
        for (const client of room.awareness.getStates().keys()) if (!before.has(client)) clients.add(client);
      } catch { return; }
      for (const other of room.peers.keys()) if (other !== peer) this.sendFrame(other, room, roomFrameKinds.awareness, frame.payload);
      return;
    }
    if (frame.kind !== roomFrameKinds.update || peer.role === 'viewer') return;
    const update = frame.payload.slice();
    try { Y.decodeUpdate(update); } catch { return; }
    const epoch = room.epoch;
    const stored = await room.serial(() => this.store(room, epoch, update, peer.userId));
    if (!stored || room.epoch !== epoch) return;
    Y.applyUpdate(room.doc, update, peer);
    room.seeded = true;
    for (const other of room.peers.keys()) if (other !== peer) this.sendFrame(other, room, roomFrameKinds.update, update);
    this.sendFrame(peer, room, roomFrameKinds.ack, Y.encodeStateVector(room.doc));
    this.assignRoles(room);
    if (room.pendingUpdates >= compactAfterUpdates || room.pendingBytes >= compactAfterBytes) void room.serial(() => this.compact(room));
  }

  /** What this process holds of a room, so a saver can never claim more than the server stored. */
  heldStateVector(workspaceId: string, pageId: string, epoch: number): Map<number, number> | null {
    const room = this.rooms.get(this.key(workspaceId, pageId));
    return room?.epoch === epoch ? Y.decodeStateVector(Y.encodeStateVector(room.doc)) : null;
  }

  /** After the saver's write committed. */
  saved(workspaceId: string, pageId: string, epoch: number, revision: string, stateVector: Uint8Array, by: MemberRef): void {
    const room = this.rooms.get(this.key(workspaceId, pageId));
    if (!room || room.epoch !== epoch) return;
    room.savedRevision = revision;
    room.savedStateVector = stateVector;
    const message: RoomServerMessage = { t: 'roomSaved', pageId: room.pageId, epoch, revision, stateVector: bytesToBase64(stateVector), by };
    for (const peer of room.peers.keys()) peer.sendJson(message);
    void room.serial(() => this.compact(room));
  }

  /**
   * A write that changed content outside the room: the room starts again from that revision with a new epoch. Called
   * inside the write's transaction; returns the new epoch, or null when the page had no room.
   */
  async resetInTransaction(client: PoolClient, workspaceId: string, pageId: string, revision: string): Promise<number | null> {
    const epoch = newEpoch();
    const result = await client.query(`UPDATE page_collab_rooms SET epoch = $3, base_revision = $4, saved_revision = NULL,
      saved_state_vector = NULL, snapshot = NULL, snapshot_seq = 0, updated_at = now()
      WHERE workspace_id = $1 AND page_id = $2`, [workspaceId, pageId, epoch, revision]);
    if (!result.rowCount) return null;
    await client.query('DELETE FROM page_collab_updates WHERE workspace_id = $1 AND page_id = $2', [workspaceId, pageId]);
    return epoch;
  }

  /** After a reset committed: clients drop their document and seed again from the new revision. */
  reset(workspaceId: string, pageId: string, epoch: number, revision: string, reason: RoomResetReason, by: MemberRef | null): void {
    const room = this.rooms.get(this.key(workspaceId, pageId));
    if (!room) return;
    const peers = [...room.peers.keys()];
    this.rooms.delete(this.key(workspaceId, pageId));
    clearTimeout(room.unloadTimer);
    room.awareness.destroy();
    room.doc.destroy();
    for (const peer of peers) peer.sendJson({ t: 'roomReset', pageId: room.pageId, epoch, revision, reason, by });
    void Promise.all(peers.map(peer => this.join(peer, room.pageId).catch(() => {
      peer.sendJson({ t: 'roomError', pageId: room.pageId, code: 'SERVICE_UNAVAILABLE' });
    })));
  }

  /** A title-only write outside the room becomes a server-made edit of the room's title, so editing goes on. */
  async titleChanged(workspaceId: string, pageId: string, title: string): Promise<void> {
    const exists = await this.pool.query('SELECT 1 FROM page_collab_rooms WHERE workspace_id = $1 AND page_id = $2', [workspaceId, pageId]);
    if (!exists.rowCount) return;
    const room = this.room(workspaceId, pageId);
    try {
      await this.ensureLoaded(room);
      if (!room.seeded) return;
      const text = room.doc.getText('title');
      if (text.toString() === title) return;
      let update: Uint8Array | null = null;
      const capture = (value: Uint8Array) => { update = value; };
      room.doc.once('update', capture);
      room.doc.transact(() => { text.delete(0, text.length); text.insert(0, title); }, 'server');
      if (!update) return;
      const epoch = room.epoch;
      if (!await room.serial(() => this.store(room, epoch, update!, null))) return;
      for (const peer of room.peers.keys()) this.sendFrame(peer, room, roomFrameKinds.update, update);
    } finally { this.release(room); }
  }

  /** Rooms in memory, for tests. */
  get size(): number { return this.rooms.size; }

  async close(): Promise<void> {
    this.closed = true;
    const listener = this.listener;
    this.listener = null;
    await listener?.end().catch(() => undefined);
    await Promise.all([...this.rooms.values()].map(room => room.serial(() => this.compact(room)).catch(() => undefined)));
    for (const room of this.rooms.values()) { clearTimeout(room.unloadTimer); room.doc.destroy(); }
    this.rooms.clear();
  }

  private room(workspaceId: string, pageId: string): Room {
    const key = this.key(workspaceId, pageId);
    let room = this.rooms.get(key);
    if (!room) this.rooms.set(key, room = new Room(workspaceId.toLowerCase(), pageId.toLowerCase()));
    return room;
  }

  private ensureLoaded(room: Room): Promise<void> {
    room.loaded ??= this.load(room).catch(error => { room.loaded = undefined; throw error; });
    return room.loaded;
  }

  private async load(room: Room): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO page_collab_rooms (workspace_id, page_id, epoch, base_revision)
        SELECT workspace_id, id, $3, revision FROM pages WHERE workspace_id = $1 AND id = $2
        ON CONFLICT (workspace_id, page_id) DO NOTHING`, [room.workspaceId, room.pageId, newEpoch()]);
      const result = await client.query<RoomRow>(`SELECT epoch, base_revision, saved_revision, saved_state_vector, snapshot, snapshot_seq
        FROM page_collab_rooms WHERE workspace_id = $1 AND page_id = $2`, [room.workspaceId, room.pageId]);
      const row = result.rows[0];
      if (!row) throw new Error('Room page disappeared');
      const updates = await client.query<{ seq: string; update: Buffer }>(`SELECT seq, "update" FROM page_collab_updates
        WHERE workspace_id = $1 AND page_id = $2 AND epoch = $3 ORDER BY seq`, [room.workspaceId, room.pageId, row.epoch]);
      await client.query('COMMIT');
      room.epoch = Number(row.epoch);
      room.baseRevision = row.base_revision;
      room.savedRevision = row.saved_revision;
      room.savedStateVector = row.saved_state_vector ? new Uint8Array(row.saved_state_vector) : null;
      if (row.snapshot) Y.applyUpdate(room.doc, row.snapshot, 'storage');
      let seq = Number(row.snapshot_seq);
      for (const item of updates.rows) { Y.applyUpdate(room.doc, item.update, 'storage'); seq = Number(item.seq); }
      room.nextSeq = seq + 1;
      room.pendingUpdates = updates.rows.length;
      room.pendingBytes = updates.rows.reduce((sum, item) => sum + item.update.byteLength, 0);
      room.seeded = Boolean(row.snapshot) || updates.rows.length > 0;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  /** Stores one update; false when the room moved to another epoch meanwhile. */
  private async store(room: Room, epoch: number, update: Uint8Array, userId: string | null): Promise<boolean> {
    const seq = room.nextSeq;
    const result = await this.pool.query(`INSERT INTO page_collab_updates (workspace_id, page_id, epoch, seq, "update", user_id)
      SELECT workspace_id, page_id, epoch, $4, $5, $6 FROM page_collab_rooms WHERE workspace_id = $1 AND page_id = $2 AND epoch = $3`,
    [room.workspaceId, room.pageId, epoch, seq, Buffer.from(update), userId]);
    if (!result.rowCount) return false;
    room.nextSeq = seq + 1;
    room.pendingUpdates += 1;
    room.pendingBytes += update.byteLength;
    return true;
  }

  private async compact(room: Room): Promise<void> {
    if (!room.pendingUpdates || this.rooms.get(this.key(room.workspaceId, room.pageId)) !== room) return;
    const snapshot = Y.encodeStateAsUpdate(room.doc);
    if (snapshot.byteLength > roomStateByteLimit) { await this.rebuild(room); return; }
    const lastSeq = room.nextSeq - 1;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(`UPDATE page_collab_rooms SET snapshot = $4, snapshot_seq = $5, updated_at = now()
        WHERE workspace_id = $1 AND page_id = $2 AND epoch = $3`, [room.workspaceId, room.pageId, room.epoch, Buffer.from(snapshot), lastSeq]);
      if (updated.rowCount) {
        await client.query('DELETE FROM page_collab_updates WHERE workspace_id = $1 AND page_id = $2 AND epoch = $3 AND seq <= $4',
          [room.workspaceId, room.pageId, room.epoch, lastSeq]);
      }
      await client.query('COMMIT');
      room.pendingUpdates = 0;
      room.pendingBytes = 0;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  /** Starts the room again from the page's current revision; used when its Yjs state grew past the limit. */
  private async rebuild(room: Room): Promise<void> {
    const client = await this.pool.connect();
    let epoch: number | null = null;
    let revision = '';
    try {
      await client.query('BEGIN');
      const page = await client.query<{ revision: string }>('SELECT revision FROM pages WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
        [room.workspaceId, room.pageId]);
      revision = page.rows[0]?.revision ?? room.baseRevision;
      epoch = await this.resetInTransaction(client, room.workspaceId, room.pageId, revision);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
    if (epoch !== null) this.reset(room.workspaceId, room.pageId, epoch, revision, 'rebuild', null);
  }

  /** The first editor seeds an empty room; the first editor saves. Viewers never do either. */
  private assignRoles(room: Room): void {
    const editor = [...room.peers.keys()].find(peer => peer.role !== 'viewer') ?? null;
    if (editor === room.saver) return;
    const previous = room.saver;
    room.saver = editor;
    if (previous && room.peers.has(previous)) previous.sendJson(this.roleMessage(room, previous));
    if (editor) editor.sendJson(this.roleMessage(room, editor));
  }

  private roleMessage(room: Room, peer: RoomPeer): RoomServerMessage {
    const saver = room.saver === peer;
    return { t: 'roomRole', pageId: room.pageId, epoch: room.epoch, seed: saver && !room.seeded, saver };
  }

  private roomMessage(room: Room, peer: RoomPeer): RoomServerMessage {
    const saver = room.saver === peer;
    return { t: 'room', pageId: room.pageId, epoch: room.epoch, baseRevision: room.baseRevision, savedRevision: room.savedRevision,
      savedStateVector: room.savedStateVector ? bytesToBase64(room.savedStateVector) : null,
      seed: saver && !room.seeded, saver, readOnly: peer.role === 'viewer' };
  }

  private broadcastAwareness(room: Room, clients: number[], except: RoomPeer): void {
    if (!clients.length) return;
    const update = encodeAwarenessUpdate(room.awareness, clients);
    for (const peer of room.peers.keys()) if (peer !== except) this.sendFrame(peer, room, roomFrameKinds.awareness, update);
  }

  private sendFrame(peer: RoomPeer, room: Room, kind: RoomFrame['kind'], payload: Uint8Array): void {
    peer.sendBinary(encodeRoomFrame({ kind, pageId: room.pageId, epoch: room.epoch, payload }));
  }

  private release(room: Room): void {
    if (room.peers.size || room.unloadTimer) return;
    room.unloadTimer = setTimeout(() => {
      room.unloadTimer = undefined;
      if (room.peers.size) return;
      void room.serial(() => this.compact(room)).catch(() => undefined).finally(() => {
        if (room.peers.size || this.rooms.get(this.key(room.workspaceId, room.pageId)) !== room) return;
        this.rooms.delete(this.key(room.workspaceId, room.pageId));
        room.awareness.destroy();
        room.doc.destroy();
      });
    }, unloadAfterMs);
    room.unloadTimer.unref();
  }
}

function encodeStateVectorMap(state: Map<number, number>): Uint8Array {
  // Yjs has no public encoder for a bare map; a v1 state vector is a varuint count followed by (client, clock) pairs.
  const bytes: number[] = [];
  const varuint = (value: number) => {
    let rest = value;
    while (rest > 0x7f) { bytes.push((rest & 0x7f) | 0x80); rest = Math.floor(rest / 128); }
    bytes.push(rest);
  };
  const entries = [...state].filter(([, clock]) => clock > 0);
  varuint(entries.length);
  for (const [client, clock] of entries) { varuint(client); varuint(clock); }
  return new Uint8Array(bytes);
}
