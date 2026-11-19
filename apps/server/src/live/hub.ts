import type { LiveClientMessage, LivePresenceMember, LiveServerMessage, MemberRef } from '@nbase/contracts';
import { decodeRoomFrame, liveCloseAuth, liveMessageByteLimit, parseLiveClientMessage, roomFrameByteLimit, roomFramesPerSecond,
  roomSubscriptionLimit } from '@nbase/contracts';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { WebSocket } from 'ws';
import type { AuthRepository } from '../auth/repository.js';
import { publicOriginConfig, readSessionToken, sessionTokenHash } from '../auth/session.js';
import { authorizeWorkspaceMember, WorkspaceRouteError } from '../auth/workspace.js';
import { sendError } from '../pages/routes.js';
import { RoomManager, type RoomPeer } from './rooms.js';

const perUserLimit = 20;
const processLimit = 500;
const recheckMs = 30_000;
const messagesPerSecond = 20;

interface Connection {
  socket: WebSocket;
  workspaceId: string;
  userId: string;
  loginName: string;
  role: string;
  sessionHash: Buffer;
  pageId: string | null;
  editing: boolean;
  windowStart: number;
  windowCount: number;
  frameWindowStart: number;
  frameWindowCount: number;
  alive: boolean;
  peer: RoomPeer;
  rooms: Set<string>;
}

/**
 * Presence, save and comment notices for open workspace tabs (docs/architecture/collaboration.md). Everything here
 * lives in process memory; a restarted server simply sees the clients reconnect and report again.
 */
export class LiveHub {
  private readonly connections = new Set<Connection>();
  private readonly pages = new Map<string, Set<Connection>>();
  private readonly names = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  readonly rooms: RoomManager;

  constructor(private readonly pool: Pool, private readonly auth: AuthRepository, realtime = process.env.NBASE_REALTIME !== 'off') {
    this.rooms = new RoomManager(pool, realtime, userId => this.loginName(userId));
  }

  async register(app: FastifyInstance, publicOrigin: string): Promise<void> {
    const { origin, secure } = publicOriginConfig(publicOrigin);
    await app.register(fastifyWebsocket, { options: { maxPayload: roomFrameByteLimit, perMessageDeflate: false } });
    await this.rooms.listen();
    const accepted = new WeakMap<FastifyRequest, { userId: string; role: string; loginName: string; sessionHash: Buffer }>();

    app.get<{ Params: { workspaceId: string } }>('/api/workspaces/:workspaceId/live', {
      websocket: true,
      // Runs before the upgrade, so a refused handshake gets an ordinary HTTP error.
      preValidation: async (request, reply) => {
        try {
          const member = await authorizeWorkspaceMember(request, this.auth, origin, secure, request.params.workspaceId, false);
          // Browsers always send Origin on a WebSocket handshake; checking it stops cross-site WebSocket hijacking.
          if (request.headers.origin !== origin) throw new WorkspaceRouteError(403, 'ORIGIN_INVALID');
          if (!request.ws) throw new WorkspaceRouteError(426, 'UPGRADE_REQUIRED');
          if (this.connections.size >= processLimit
            || [...this.connections].filter(item => item.userId === member.userId).length >= perUserLimit) {
            throw new WorkspaceRouteError(429, 'RATE_LIMITED');
          }
          const token = readSessionToken(request.headers.cookie, secure)!;
          const session = await this.auth.loadSession(sessionTokenHash(token));
          accepted.set(request, { ...member, loginName: session?.loginName ?? '', sessionHash: sessionTokenHash(token) });
        } catch (error) { return sendError(request, reply, error, secure); }
      },
    }, (socket, request) => {
      const member = accepted.get(request);
      if (!member) { socket.close(liveCloseAuth); return; }
      this.names.set(member.userId, member.loginName);
      const workspaceId = request.params.workspaceId.toLowerCase();
      const peer: RoomPeer = { workspaceId, userId: member.userId, loginName: member.loginName, role: member.role,
        sendJson: message => this.send(connection, message),
        sendBinary: bytes => { if (socket.readyState === socket.OPEN) socket.send(bytes); } };
      const connection: Connection = { socket, workspaceId, ...member, pageId: null, editing: false, windowStart: Date.now(),
        windowCount: 0, frameWindowStart: Date.now(), frameWindowCount: 0, alive: true, peer, rooms: new Set() };
      this.connections.add(connection);
      this.send(connection, { t: 'hello', userId: member.userId });
      socket.on('pong', () => { connection.alive = true; });
      socket.on('message', (data, isBinary) => {
        const now = Date.now();
        if (isBinary) {
          if (now - connection.frameWindowStart >= 1000) { connection.frameWindowStart = now; connection.frameWindowCount = 0; }
          // A client that floods document updates is broken or hostile; dropping frames silently would fork its document.
          if (++connection.frameWindowCount > roomFramesPerSecond) { socket.close(1008); return; }
          const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
          const frame = decodeRoomFrame(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
          if (frame) void this.rooms.frame(peer, frame).catch(() => socket.close(1011));
          return;
        }
        if (now - connection.windowStart >= 1000) { connection.windowStart = now; connection.windowCount = 0; }
        if (++connection.windowCount > messagesPerSecond) return;
        const text = data.toString();
        if (Buffer.byteLength(text) > liveMessageByteLimit) return;
        const message = parseLiveClientMessage(text);
        if (message) this.receive(connection, message);
      });
      socket.on('close', () => this.drop(connection));
      this.start();
    });

    app.addHook('onClose', async () => { clearInterval(this.timer); this.timer = undefined; await this.rooms.close(); });
  }

  /** A member saved the page; tabs that have it open offer to load the new revision. */
  pageSaved(workspaceId: string, pageId: string, revision: string, userId: string): void {
    const watchers = this.pages.get(this.key(workspaceId, pageId));
    if (!watchers?.size) return;
    void this.loginName(userId).then(loginName => {
      const message: LiveServerMessage = { t: 'saved', pageId: pageId.toLowerCase(), revision, by: { userId, loginName } };
      for (const connection of this.pages.get(this.key(workspaceId, pageId)) ?? []) this.send(connection, message);
    }).catch(() => { /* A missed notice only delays the reload offer until the next read. */ });
  }

  commentsChanged(workspaceId: string, pageId: string): void {
    const message: LiveServerMessage = { t: 'comments', pageId: pageId.toLowerCase() };
    for (const connection of this.pages.get(this.key(workspaceId, pageId)) ?? []) this.send(connection, message);
  }

  /** Open connections, for tests. */
  get size(): number { return this.connections.size; }

  private key(workspaceId: string, pageId: string): string { return `${workspaceId.toLowerCase()}:${pageId.toLowerCase()}`; }

  private receive(connection: Connection, message: LiveClientMessage): void {
    if (message.t === 'ping') { this.send(connection, { t: 'pong' }); return; }
    if (message.t === 'join') {
      if (connection.rooms.has(message.pageId)) return;
      if (connection.rooms.size >= roomSubscriptionLimit) {
        this.send(connection, { t: 'roomError', pageId: message.pageId, code: 'ROOM_LIMIT' });
        return;
      }
      connection.rooms.add(message.pageId);
      void this.rooms.join(connection.peer, message.pageId).catch(() => {
        connection.rooms.delete(message.pageId);
        this.send(connection, { t: 'roomError', pageId: message.pageId, code: 'SERVICE_UNAVAILABLE' });
      });
      return;
    }
    if (message.t === 'leave') {
      if (connection.rooms.delete(message.pageId)) this.rooms.leave(connection.peer, message.pageId);
      return;
    }
    const editing = message.pageId !== null && message.editing && connection.role !== 'viewer';
    const previous = connection.pageId;
    if (previous === message.pageId && connection.editing === editing) return;
    if (previous) this.pages.get(this.key(connection.workspaceId, previous))?.delete(connection);
    connection.pageId = message.pageId;
    connection.editing = editing;
    if (message.pageId) {
      const key = this.key(connection.workspaceId, message.pageId);
      let watchers = this.pages.get(key);
      if (!watchers) this.pages.set(key, watchers = new Set());
      watchers.add(connection);
    }
    if (previous && previous !== message.pageId) this.presence(connection.workspaceId, previous);
    if (message.pageId) this.presence(connection.workspaceId, message.pageId);
  }

  private presence(workspaceId: string, pageId: string): void {
    const key = this.key(workspaceId, pageId);
    const watchers = this.pages.get(key);
    if (!watchers?.size) { this.pages.delete(key); return; }
    const members = new Map<string, LivePresenceMember>();
    for (const item of watchers) {
      const known = members.get(item.userId);
      if (known) known.editing ||= item.editing;
      else members.set(item.userId, { userId: item.userId, loginName: item.loginName, editing: item.editing });
    }
    const message: LiveServerMessage = { t: 'presence', pageId, members: [...members.values()]
      .sort((a, b) => a.loginName.localeCompare(b.loginName)) };
    for (const item of watchers) this.send(item, message);
  }

  private drop(connection: Connection): void {
    if (!this.connections.delete(connection)) return;
    for (const pageId of connection.rooms) this.rooms.leave(connection.peer, pageId);
    connection.rooms.clear();
    if (connection.pageId) {
      this.pages.get(this.key(connection.workspaceId, connection.pageId))?.delete(connection);
      this.presence(connection.workspaceId, connection.pageId);
    }
    if (!this.connections.size) { clearInterval(this.timer); this.timer = undefined; }
  }

  private send(connection: Connection, message: LiveServerMessage): void {
    if (connection.socket.readyState === connection.socket.OPEN) connection.socket.send(JSON.stringify(message));
  }

  private async loginName(userId: string): Promise<string> {
    const known = this.names.get(userId);
    if (known !== undefined) return known;
    const result = await this.pool.query<{ login_name: string }>('SELECT login_name FROM users WHERE id = $1', [userId]);
    const name = result.rows[0]?.login_name ?? '';
    if (this.names.size > 10000) this.names.clear();
    this.names.set(userId, name);
    return name;
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.recheck(); }, recheckMs);
    this.timer.unref();
  }

  /** Ends connections whose session expired, whose member was removed or changed role, or that stopped answering pings. */
  async recheck(): Promise<void> {
    const sessions = new Map<string, Promise<boolean>>();
    const valid = (connection: Connection) => {
      const key = `${connection.sessionHash.toString('hex')}:${connection.workspaceId}:${connection.role}`;
      let check = sessions.get(key);
      if (!check) {
        check = (async () => {
          const session = await this.auth.loadSession(connection.sessionHash);
          if (!session || session.revoked || session.disabled || session.expiresAt.getTime() <= Date.now()) return false;
          const membership = (await this.auth.workspacesForUser(session.userId)).find(item => item.id === connection.workspaceId);
          return membership?.role === connection.role;
        })().catch(() => true);
        sessions.set(key, check);
      }
      return check;
    };
    await Promise.all([...this.connections].map(async connection => {
      if (!connection.alive) { connection.socket.terminate(); return; }
      if (!await valid(connection)) {
        connection.socket.close(liveCloseAuth);
        // A client that never answers the close frame would otherwise hold the socket for ws's 30-second close timeout.
        setTimeout(() => connection.socket.terminate(), 2000).unref();
        return;
      }
      connection.alive = false;
      connection.socket.ping();
    }));
  }
}
