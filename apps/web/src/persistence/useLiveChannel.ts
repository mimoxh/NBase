import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveClientMessage, LivePresenceMember, LiveServerMessage, RoomServerMessage } from '@nbase/contracts';
import { decodeRoomFrame, liveCloseAuth, roomFramesPerSecond } from '@nbase/contracts';
import type { RoomHandler, RoomTransport } from './collab/roomClient';

const editingIdleMs = 15_000;
const pingMs = 25_000;
const silentLimitMs = 70_000;
const maxBackoffMs = 30_000;
/** Below the server's limit, which closes the connection when it is exceeded. */
const framesPerSecond = Math.floor(roomFramesPerSecond * 0.8);
const roomMessageTypes = new Set<string>(['room', 'roomRole', 'roomSaved', 'roomReset', 'roomError']);

/** Room subscriptions on the live connection (docs/architecture/realtime.md). */
export interface LiveRooms {
  /** Joins the page's room now and after every reconnect; a second subscription for a page replaces the first. */
  subscribe(pageId: string, handler: RoomHandler): RoomTransport;
}

export type LiveSaved = Extract<LiveServerMessage, { t: 'saved' }>;

export interface LiveChannelOptions {
  workspaceId: string | null;
  pageId: string | null;
  /** Viewers and read-only views never report editing. */
  canEdit: boolean;
  onSaved: (message: LiveSaved) => void;
  onComments: (pageId: string) => void;
  /** The server ended the connection because the session or membership is no longer valid. */
  onAuthClosed: () => void;
}

function parse(data: unknown): LiveServerMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const value = JSON.parse(data) as LiveServerMessage;
    return value && typeof value === 'object' && typeof value.t === 'string' ? value : null;
  } catch { return null; }
}

/**
 * One WebSocket per tab for presence, save and comment notices (docs/architecture/collaboration.md) and the
 * real-time rooms of co-edited pages (docs/architecture/realtime.md). Single-user editing and saving need none of
 * it: when the connection is down the workspace shows no presence and rooms keep their changes locally.
 */
export interface LiveChannel {
  others: LivePresenceMember[];
  noteEdit: () => void;
  /** Null where rooms are deliberately unavailable (unit tests); production always provides them. */
  rooms: LiveRooms | null;
}

export function useLiveChannel({ workspaceId, pageId, canEdit, onSaved, onComments, onAuthClosed }: LiveChannelOptions): LiveChannel {
  const [presence, setPresence] = useState<{ pageId: string; members: LivePresenceMember[] } | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const focusRef = useRef<LiveClientMessage>({ t: 'focus', pageId: null, editing: false });
  const handlers = useRef({ onSaved, onComments, onAuthClosed });
  handlers.current = { onSaved, onComments, onAuthClosed };
  const idleTimer = useRef(0);
  const roomsRef = useRef(new Map<string, RoomHandler>());
  const framesRef = useRef({ windowStart: 0, count: 0, queue: [] as Uint8Array[], timer: 0 });

  const send = (message: LiveClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const drainFrames = () => {
    const frames = framesRef.current;
    frames.timer = 0;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) { frames.queue = []; return; }
    while (frames.queue.length) {
      const now = Date.now();
      if (now - frames.windowStart >= 1000) { frames.windowStart = now; frames.count = 0; }
      if (frames.count >= framesPerSecond) {
        frames.timer = window.setTimeout(drainFrames, frames.windowStart + 1000 - now);
        return;
      }
      frames.count++;
      socket.send(frames.queue.shift()!);
    }
  };

  const rooms = useRef<LiveRooms>({
    subscribe: (rawPageId, handler) => {
      const pageId = rawPageId.toLowerCase();
      const map = roomsRef.current;
      if (map.has(pageId)) send({ t: 'leave', pageId });
      map.set(pageId, handler);
      send({ t: 'join', pageId });
      return {
        isOpen: () => socketRef.current?.readyState === WebSocket.OPEN,
        send: bytes => {
          const socket = socketRef.current;
          if (map.get(pageId) !== handler || socket?.readyState !== WebSocket.OPEN) return false;
          framesRef.current.queue.push(bytes);
          if (!framesRef.current.timer) drainFrames();
          return true;
        },
        close: () => {
          if (map.get(pageId) !== handler) return;
          map.delete(pageId);
          send({ t: 'leave', pageId });
        },
      };
    },
  }).current;

  useEffect(() => {
    if (!workspaceId) return;
    let closed = false;
    let attempt = 0;
    let retryTimer = 0;
    let pingTimer = 0;
    let lastHeard = Date.now();
    const connect = () => {
      if (closed) return;
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/workspaces/${encodeURIComponent(workspaceId)}/live`;
      let socket: WebSocket;
      try { socket = new WebSocket(url); } catch { schedule(); return; }
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;
      socket.onopen = () => {
        attempt = 0; lastHeard = Date.now();
        socket.send(JSON.stringify(focusRef.current));
        for (const [pageId, handler] of roomsRef.current) {
          socket.send(JSON.stringify({ t: 'join', pageId } satisfies LiveClientMessage));
          handler.connection(true);
        }
      };
      socket.onmessage = event => {
        lastHeard = Date.now();
        if (event.data instanceof ArrayBuffer) {
          const frame = decodeRoomFrame(new Uint8Array(event.data));
          if (frame) roomsRef.current.get(frame.pageId)?.frame(frame);
          return;
        }
        const message = parse(event.data);
        if (!message) return;
        if (message.t === 'hello') setSelfId(message.userId);
        else if (message.t === 'presence') setPresence({ pageId: message.pageId, members: message.members });
        else if (message.t === 'saved') handlers.current.onSaved(message);
        else if (message.t === 'comments') handlers.current.onComments(message.pageId);
        else if (roomMessageTypes.has(message.t)) {
          const room = message as RoomServerMessage;
          roomsRef.current.get(room.pageId)?.message(room);
        }
      };
      socket.onclose = event => {
        if (socketRef.current === socket) socketRef.current = null;
        setPresence(null);
        framesRef.current.queue = [];
        for (const handler of [...roomsRef.current.values()]) handler.connection(false);
        if (closed) return;
        if (event.code === liveCloseAuth) { handlers.current.onAuthClosed(); return; }
        schedule();
      };
    };
    const schedule = () => {
      if (closed) return;
      const delay = Math.min(maxBackoffMs, 1000 * 2 ** attempt++) * (0.75 + Math.random() * 0.5);
      retryTimer = window.setTimeout(connect, delay);
    };
    const reconnectNow = () => {
      if (closed || socketRef.current) return;
      window.clearTimeout(retryTimer); attempt = 0; connect();
    };
    pingTimer = window.setInterval(() => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      // A connection that went quiet (sleep, a dropped Wi-Fi) is closed so the retry loop takes over.
      if (Date.now() - lastHeard > silentLimitMs) { socket.close(); return; }
      socket.send(JSON.stringify({ t: 'ping' } satisfies LiveClientMessage));
    }, pingMs);
    // The browser knows about a lost interface long before the silence check would; the retry loop and `online` reconnect.
    const dropNow = () => socketRef.current?.close();
    window.addEventListener('online', reconnectNow);
    window.addEventListener('offline', dropNow);
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retryTimer); window.clearInterval(pingTimer);
      window.removeEventListener('online', reconnectNow);
      window.removeEventListener('offline', dropNow);
      socketRef.current?.close(1000);
      socketRef.current = null;
      setPresence(null);
    };
  }, [workspaceId]);

  useEffect(() => { window.clearTimeout(idleTimer.current); setEditing(false); }, [pageId, canEdit]);
  useEffect(() => () => window.clearTimeout(idleTimer.current), []);

  useEffect(() => {
    const next: LiveClientMessage = { t: 'focus', pageId, editing: Boolean(pageId) && canEdit && editing };
    const previous = focusRef.current;
    focusRef.current = next;
    if (previous.t !== 'focus' || previous.pageId !== next.pageId || previous.editing !== next.editing) send(next);
  }, [pageId, canEdit, editing]);

  /** Marks this tab as editing the open page until it has been idle for a while. */
  const noteEdit = useCallback(() => {
    window.clearTimeout(idleTimer.current);
    setEditing(true);
    idleTimer.current = window.setTimeout(() => setEditing(false), editingIdleMs);
  }, []);

  const others = presence && presence.pageId === pageId ? presence.members.filter(member => member.userId !== selfId) : [];
  return { others, noteEdit, rooms };
}
