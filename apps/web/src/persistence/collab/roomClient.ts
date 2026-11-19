import type { MemberRef, RoomErrorCode, RoomFrame, RoomResetReason, RoomServerMessage } from '@nbase/contracts';
import { base64ToBytes, encodeRoomFrame, roomFrameByteLimit, roomFrameHeaderBytes, roomFrameKinds } from '@nbase/contracts';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { roomRecordKey, type RoomRecord, type RoomStore } from './roomStore';

/** Transaction origins the room client applies itself; everything else on the document is a local edit. */
const remoteOrigin = Symbol('room-remote');
const storeOrigin = Symbol('room-store');
export const titleOrigin = Symbol('room-title');

const saveDebounceMs = 1500;
const saveMaxWaitMs = 10_000;
const saveRetryMs = 5000;
const persistDebounceMs = 300;
const updateBatchMs = 50;
const awarenessBatchMs = 120;
const defaultOfflineAfterMs = 8000;
/** A room that stays empty this long has no one to seed it; the page opens the ordinary way instead. */
const waitingFallbackMs = 12_000;

export type StateVector = Map<number, number>;

/** True when `state` holds every change `required` counts. */
export function covers(state: StateVector, required: StateVector | [number, number][]): boolean {
  for (const [client, clock] of required) if ((state.get(client) ?? 0) < clock) return false;
  return true;
}

function mergeMax(into: StateVector, from: StateVector): void {
  for (const [client, clock] of from) if ((into.get(client) ?? 0) < clock) into.set(client, clock);
}

function emptyUpdate(update: Uint8Array): boolean {
  const decoded = Y.decodeUpdate(update);
  return decoded.structs.length === 0 && decoded.ds.clients.size === 0;
}

/** One page's subscription on the live connection. */
export interface RoomTransport {
  /** False when the frame could not be sent; the next state exchange carries what was lost. */
  send(bytes: Uint8Array): boolean;
  isOpen(): boolean;
  /** Leaves the room. */
  close(): void;
}

/** What the live connection delivers for one page. */
export interface RoomHandler {
  message(message: RoomServerMessage): void;
  frame(frame: RoomFrame): void;
  connection(open: boolean): void;
}

/**
 * How a saver's revision write ended: `stale` (another saver got there first, or the room moved on), `invalid`
 * (the server rejected the content), `retry` (network or server trouble), `unavailable` (nothing to read the
 * content from right now).
 */
export type RoomSaveResult = 'saved' | 'stale' | 'invalid' | 'retry' | 'unavailable';
/** Writes the current content as a revision; reads the state vector only once the content it sends is fixed. */
export type RoomSave = (epoch: number, stateVector: () => Uint8Array) => Promise<RoomSaveResult>;

export type RoomFallbackCode = RoomErrorCode | 'TOO_LARGE' | 'OFFLINE';

export type RoomEvent =
  | { type: 'change' }
  /** This tab edited the document. */
  | { type: 'local' }
  | { type: 'title'; title: string }
  | { type: 'saved'; revision: string; by: MemberRef }
  /** The room started again; this tab had nothing the server lacked and should load the page again. */
  | { type: 'reload'; reason: RoomResetReason; by: MemberRef | null }
  /** Changes of this tab from an earlier room that the server never received. The record stays stored until resolved. */
  | { type: 'conflict'; record: RoomRecord }
  /** The room is unavailable; the page goes back to single-user saving. `unsaved` holds what no revision has yet. */
  | { type: 'fallback'; code: RoomFallbackCode; unsaved: RoomRecord | null };

export type RoomPhase = 'joining' | 'waiting' | 'ready' | 'ended';

/** The subset of a Lexical collaboration provider the editor binding uses. */
export interface RoomProvider {
  awareness: Awareness;
  connect(): void;
  disconnect(): void;
  on(type: string, listener: (...args: unknown[]) => void): void;
  off(type: string, listener: (...args: unknown[]) => void): void;
}

export interface RoomClientOptions {
  userId: string;
  workspaceId: string;
  pageId: string;
  /** False for viewers: they follow the room but never send document changes. */
  canWrite: boolean;
  store: RoomStore;
  connect(handler: RoomHandler): RoomTransport;
  onEvent(event: RoomEvent): void;
  save?: RoomSave | undefined;
  /** Without a server answer for this long, the page opens from the local copy, or falls back when there is none. */
  offlineAfterMs?: number | undefined;
  /** True never joins the room: the newest stored record is opened as is (the conflict view of an unsynced room). */
  offline?: boolean | undefined;
  /** Whether the document holds content yet; by default any Yjs item counts. */
  hasContent?: ((doc: Y.Doc) => boolean) | undefined;
}

/**
 * The client side of one real-time room (docs/architecture/realtime.md). It owns the page's Y.Doc and awareness,
 * exchanges state with the server, tracks which of this tab's changes the server stored (ack) and which a
 * revision holds (saved), keeps a local copy in the room store, and, when this tab is the room's saver, decides
 * when to write a revision. It knows nothing about Lexical, so a whiteboard can use it with its own binding.
 */
export class RoomClient {
  phase: RoomPhase = 'joining';
  epoch: number | null = null;
  baseRevision: string | null = null;
  savedRevision: string | null = null;
  saver = false;
  seed = false;
  readOnly: boolean;
  /** Joined on the current connection. */
  connected = false;
  /** The current connection exchanged state with the server. */
  synced = false;
  doc: Y.Doc | null = null;
  awareness: Awareness | null = null;
  readonly acked: StateVector = new Map();
  readonly saved: StateVector = new Map();
  /** Highest clock of every client id this tab (or an earlier session of it) wrote with. */
  readonly local: StateVector = new Map();
  saveFailed = false;

  private readonly options: RoomClientOptions;
  private transport: RoomTransport | null = null;
  private records: RoomRecord[] | null = null;
  private inbox: (() => void)[] = [];
  private stored = false;
  private outbox: Uint8Array[] = [];
  private outboxTimer: ReturnType<typeof setTimeout> | undefined;
  private awarenessDirty = false;
  private awarenessTimer: ReturnType<typeof setTimeout> | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private offlineTimer: ReturnType<typeof setTimeout> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private waitingTimer: ReturnType<typeof setTimeout> | undefined;
  private dirtySince: number | null = null;
  private saving: Promise<void> | null = null;
  private saveAgain = false;
  private submitted: { vector: StateVector; complete: boolean } | null = null;
  private held: Uint8Array[] | null = null;
  private provider: (RoomProvider & { emit(type: string, ...args: unknown[]): void }) | null = null;
  /** An editor that connected before the room had a document; bound as soon as one exists. */
  private pending: { provider: RoomProvider & { emit(type: string, ...args: unknown[]): void }; doc: Y.Doc } | null = null;
  private seedTitle = '';
  private seededBy: RoomProvider | null = null;
  private unbind: (() => void) | null = null;
  private waiters = new Set<() => void>();

  constructor(options: RoomClientOptions) {
    this.options = options;
    this.readOnly = !options.canWrite;
  }

  get pageId(): string { return this.options.pageId; }

  start(): void {
    if (this.options.offline) {
      this.transport = { send: () => false, isOpen: () => false, close: () => undefined };
    } else {
      this.transport = this.options.connect({
        message: message => this.receive(() => this.onMessage(message)),
        frame: frame => this.receive(() => this.onFrame(frame)),
        connection: open => this.receive(() => this.onConnection(open)),
      });
    }
    this.offlineTimer = setTimeout(() => this.openOffline(), this.options.offline ? 0 : this.options.offlineAfterMs ?? defaultOfflineAfterMs);
    void this.options.store.forPage(this.options.userId, this.options.workspaceId, this.options.pageId)
      .catch(() => [] as RoomRecord[])
      .then(records => {
        this.records = records;
        const queued = this.inbox;
        this.inbox = [];
        for (const work of queued) work();
      });
  }

  /** Saves at once when this tab is the saver, then leaves the room. */
  async close(): Promise<void> {
    if (this.phase === 'ended') return;
    const pending = this.saving;
    if (this.saver && this.needsSave()) await this.saveNow();
    else if (pending) await pending;
    this.end();
  }

  /** Writes the local copy now (the tab may be closing). */
  persistNow(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    if (!this.doc || this.epoch === null || this.readOnly) return;
    if (this.hasLocalUnsaved()) {
      const record = this.record();
      this.stored = true;
      void this.options.store.put(record).catch(() => undefined);
    } else if (this.stored) {
      this.stored = false;
      void this.options.store.remove(this.key()).catch(() => undefined);
    }
  }

  // --- State --------------------------------------------------------------------------------------------------

  /** Local changes the server has not confirmed storing. */
  hasUnacked(): boolean { return !covers(this.acked, this.local); }
  /** Local changes no revision holds yet. */
  hasLocalUnsaved(): boolean { return !covers(this.saved, this.local); }

  /** The sentence the save pill shows (shell/saveTone.ts). */
  status(): string {
    if (this.phase === 'joining') return '正在连接协同…';
    if (this.phase === 'waiting') return '正在等待协同内容…';
    if (this.phase === 'ended') return '';
    if (this.saveFailed || this.peerSaveFailed()) return '未能保存';
    if (!this.connected) return this.hasLocalUnsaved() ? '离线，修改保存在本机' : '离线，正在重新连接';
    if (this.hasUnacked() || !this.synced) return this.hasLocalUnsaved() ? '保存中' : '已保存';
    return this.hasLocalUnsaved() ? '已同步，等待保存' : '已保存';
  }

  titleText(): string { return this.doc?.getText('title').toString() ?? ''; }

  /** Replaces the room title with a minimal edit, so a concurrent edit elsewhere in it survives. */
  setTitle(value: string): void {
    const doc = this.doc;
    if (!doc || this.readOnly || this.phase !== 'ready') return;
    const text = doc.getText('title');
    const current = text.toString();
    if (current === value) return;
    let start = 0;
    while (start < current.length && start < value.length && current[start] === value[start]) start++;
    let end = 0;
    while (end < current.length - start && end < value.length - start
      && current[current.length - 1 - end] === value[value.length - 1 - end]) end++;
    doc.transact(() => {
      if (current.length - start - end > 0) text.delete(start, current.length - start - end);
      if (value.length - start - end > 0) text.insert(start, value.slice(start, value.length - end));
    }, titleOrigin);
  }

  /** While the user composes text with an input method, remote edits wait so the composition is not disturbed. */
  hold(on: boolean): void {
    if (on) { this.held ??= []; return; }
    const queued = this.held;
    this.held = null;
    if (queued?.length && this.doc) Y.applyUpdate(this.doc, Y.mergeUpdates(queued), remoteOrigin);
  }

  /** Resolves true once a revision holds every local change, false after `timeoutMs`. */
  whenSaved(timeoutMs: number): Promise<boolean> {
    if (!this.hasLocalUnsaved()) return Promise.resolve(true);
    if (this.saver) void this.saveNow();
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.waiters.delete(check); resolve(false); }, timeoutMs);
      const check = () => {
        if (this.phase !== 'ended' && this.hasLocalUnsaved()) return;
        clearTimeout(timer); this.waiters.delete(check); resolve(!this.hasLocalUnsaved());
      };
      this.waiters.add(check);
    });
  }

  // --- Editor binding ------------------------------------------------------------------------------------------

  /**
   * A fresh document for an editor binding. The editor's binding must start from an empty document and learn the
   * content through its observers, so the room's state moves into this document when the provider connects.
   */
  attach(seedTitle: string): { doc: Y.Doc; provider: RoomProvider } {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalState(null);
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const provider = {
      awareness,
      connect: () => {
        if (this.phase === 'ended') return;
        if (!this.doc) { this.pending = { provider, doc }; return; }
        this.connectProvider(provider, doc);
      },
      disconnect: () => {
        if (this.pending?.provider === provider) this.pending = null;
        if (this.provider === provider && awareness.getLocalState() !== null) awareness.setLocalState(null);
      },
      on: (type: string, listener: (...args: unknown[]) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      off: (type: string, listener: (...args: unknown[]) => void) => { listeners.get(type)?.delete(listener); },
      emit: (type: string, ...args: unknown[]) => { for (const listener of [...listeners.get(type) ?? []]) listener(...args); },
    };
    this.seedTitle = seedTitle;
    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (this.awareness !== awareness) return;
      if (origin !== remoteOrigin && [...added, ...updated, ...removed].includes(doc.clientID)) this.queueAwareness();
      this.emit({ type: 'change' });
    });
    return { doc, provider };
  }

  private connectProvider(provider: RoomProvider & { emit(type: string, ...args: unknown[]): void }, doc: Y.Doc): void {
    if (this.phase === 'ended' || !this.doc) return;
    if (this.doc !== doc) {
      const previousDoc = this.doc;
      const previousAwareness = this.awareness;
      const state = Y.encodeStateAsUpdate(previousDoc);
      const others = previousAwareness ? [...previousAwareness.getStates().keys()].filter(client => client !== previousDoc.clientID) : [];
      const remoteAwareness = previousAwareness && others.length ? encodeAwarenessUpdate(previousAwareness, others) : null;
      if (previousAwareness?.getLocalState()) {
        previousAwareness.setLocalState(null);
        this.sendAwareness(previousAwareness, previousDoc.clientID);
      }
      this.bind(doc, provider.awareness);
      Y.applyUpdate(doc, state, storeOrigin);
      if (remoteAwareness) applyAwarenessUpdate(provider.awareness, remoteAwareness, remoteOrigin);
      previousAwareness?.destroy();
      previousDoc.destroy();
    }
    this.provider = provider;
    if (this.saveFailed && provider.awareness.getLocalState()) provider.awareness.setLocalStateField('saveFailed', true);
    if (provider.awareness.getLocalState()) this.queueAwareness();
    provider.emit('status', { status: this.connected ? 'connected' : 'disconnected' });
    this.maybeSeed();
  }

  /** The seeding editor writes the revision's content once the room turns out to be empty. */
  private maybeSeed(): void {
    const doc = this.doc;
    if (!doc || !this.provider || this.seededBy === this.provider || this.phase !== 'ready' || !this.seed || this.readOnly
      || !this.synced || this.hasContent()) return;
    // Lexical writes the seed in a later commit; asking twice before that would insert the content twice.
    this.seededBy = this.provider;
    const title = doc.getText('title');
    if (!title.length && this.seedTitle) doc.transact(() => title.insert(0, this.seedTitle), titleOrigin);
    this.provider.emit('sync', true);
  }

  private hasContent(): boolean {
    const doc = this.doc;
    if (!doc) return false;
    return this.options.hasContent ? this.options.hasContent(doc) : doc.store.clients.size > 0;
  }

  // --- Incoming -------------------------------------------------------------------------------------------------

  private receive(work: () => void): void {
    if (this.phase === 'ended') return;
    if (this.records === null) this.inbox.push(work);
    else work();
  }

  private onConnection(open: boolean): void {
    if (open) return; // The channel joins again; the `room` answer starts the exchange.
    this.connected = false;
    this.synced = false;
    this.outbox = [];
    this.emit({ type: 'change' });
  }

  private onMessage(message: RoomServerMessage): void {
    if (message.t === 'room') this.onRoom(message);
    else if (message.t === 'roomRole') {
      if (message.epoch !== this.epoch) return;
      this.saver = message.saver;
      this.seed = message.seed;
      this.evaluateReady();
      this.maybeSeed();
      this.scheduleSave();
      this.emit({ type: 'change' });
    } else if (message.t === 'roomSaved') {
      if (message.epoch !== this.epoch) return;
      const vector = base64ToBytes(message.stateVector);
      if (vector) mergeMax(this.saved, Y.decodeStateVector(vector));
      this.savedRevision = message.revision;
      this.setSaveFailed(false);
      this.emit({ type: 'saved', revision: message.revision, by: message.by });
      this.afterStateChange();
    } else if (message.t === 'roomReset') {
      if (this.epoch !== null && message.epoch !== this.epoch) this.epochChanged(message.reason, message.by);
    } else if (message.t === 'roomError') {
      const unsaved = this.doc && !this.readOnly && this.hasLocalUnsaved() ? this.record() : null;
      this.end();
      this.emit({ type: 'fallback', code: message.code, unsaved });
    }
  }

  private onRoom(message: Extract<RoomServerMessage, { t: 'room' }>): void {
    clearTimeout(this.offlineTimer);
    if (this.epoch === null) {
      if (!this.beginEpoch(message.epoch)) return;
    } else if (message.epoch !== this.epoch) {
      this.epochChanged('write', null);
      return;
    }
    this.baseRevision = message.baseRevision;
    this.savedRevision = message.savedRevision ?? this.savedRevision;
    const vector = message.savedStateVector ? base64ToBytes(message.savedStateVector) : null;
    if (vector) mergeMax(this.saved, Y.decodeStateVector(vector));
    this.saver = message.saver;
    this.seed = message.seed;
    this.readOnly = message.readOnly || !this.options.canWrite;
    this.connected = true;
    this.synced = false;
    this.sendFrame(roomFrameKinds.state, Y.encodeStateVector(this.doc!));
    this.emit({ type: 'change' });
  }

  /** Sets up the document for `epoch`; false when stored changes of an earlier room have to be resolved first. */
  private beginEpoch(epoch: number): boolean {
    const records = this.records ?? [];
    const own = records.find(record => record.epoch === epoch) ?? null;
    let conflict: RoomRecord | null = null;
    for (const record of records) {
      if (record.epoch === epoch) continue;
      const acked = new Map(record.acked);
      if (!covers(acked, record.local)) {
        if (!conflict || record.updatedAt > conflict.updatedAt) conflict = record;
      } else void this.options.store.remove(record.key).catch(() => undefined);
    }
    if (conflict) {
      this.end();
      this.emit({ type: 'conflict', record: conflict });
      return false;
    }
    this.epoch = epoch;
    this.useRecord(own);
    return true;
  }

  private useRecord(record: RoomRecord | null): void {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalState(null);
    this.bind(doc, awareness);
    if (record) {
      Y.applyUpdate(doc, record.update, storeOrigin);
      mergeMax(this.local, new Map(record.local));
      mergeMax(this.acked, new Map(record.acked));
      this.baseRevision ??= record.baseRevision;
      this.stored = true;
    }
    const pending = this.pending;
    if (pending) {
      this.pending = null;
      this.connectProvider(pending.provider, pending.doc);
    }
  }

  /** No answer from the server: open what this browser kept of the page, or give up on the room. */
  private openOffline(): void {
    if (this.phase !== 'joining' || this.epoch !== null) return;
    if (this.records === null) { this.offlineTimer = setTimeout(() => this.openOffline(), 500); return; }
    const newest = [...this.records].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!newest || !this.options.canWrite) {
      this.end();
      this.emit({ type: 'fallback', code: 'OFFLINE', unsaved: null });
      return;
    }
    this.epoch = newest.epoch;
    this.useRecord(newest);
    this.phase = 'ready';
    this.emit({ type: 'change' });
  }

  private epochChanged(reason: RoomResetReason, by: MemberRef | null): void {
    if (this.doc && !this.readOnly && this.hasUnacked()) {
      const record = this.record();
      void this.options.store.put(record).catch(() => undefined);
      this.end();
      this.emit({ type: 'conflict', record });
      return;
    }
    if (this.stored) void this.options.store.remove(this.key()).catch(() => undefined);
    this.stored = false;
    this.end();
    this.emit({ type: 'reload', reason, by });
  }

  private onFrame(frame: RoomFrame): void {
    const doc = this.doc;
    if (!doc || frame.epoch !== this.epoch || !this.connected) return;
    if (frame.kind === roomFrameKinds.update) {
      if (this.held) this.held.push(frame.payload.slice());
      else Y.applyUpdate(doc, frame.payload, remoteOrigin);
    } else if (frame.kind === roomFrameKinds.state) {
      let server: StateVector;
      try { server = Y.decodeStateVector(frame.payload); } catch { return; }
      mergeMax(this.acked, server);
      if (!this.readOnly) {
        const missing = Y.encodeStateAsUpdate(doc, frame.payload);
        if (!emptyUpdate(missing) && !this.sendUpdate(missing)) return;
      }
      this.synced = true;
      this.evaluateReady();
      this.maybeSeed();
      this.afterStateChange();
    } else if (frame.kind === roomFrameKinds.awareness) {
      if (!this.awareness) return;
      try { applyAwarenessUpdate(this.awareness, frame.payload, remoteOrigin); } catch { return; }
      this.emit({ type: 'change' });
    } else if (frame.kind === roomFrameKinds.ack) {
      try { mergeMax(this.acked, Y.decodeStateVector(frame.payload)); } catch { return; }
      this.afterStateChange();
    }
  }

  private evaluateReady(): void {
    if (this.phase !== 'joining' && this.phase !== 'waiting') return;
    this.phase = this.hasContent() || (this.seed && !this.readOnly) ? 'ready' : 'waiting';
    if (this.phase === 'waiting') {
      this.waitingTimer ??= setTimeout(() => {
        this.waitingTimer = undefined;
        if (this.phase !== 'waiting') return;
        this.end();
        this.emit({ type: 'fallback', code: 'OFFLINE', unsaved: null });
      }, waitingFallbackMs);
    } else {
      clearTimeout(this.waitingTimer);
      this.waitingTimer = undefined;
    }
  }

  // --- Document ------------------------------------------------------------------------------------------------

  private bind(doc: Y.Doc, awareness: Awareness): void {
    this.unbind?.();
    this.doc = doc;
    this.awareness = awareness;
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === remoteOrigin || origin === storeOrigin) {
        if (origin === remoteOrigin) { this.evaluateReady(); this.scheduleSave(); }
        this.schedulePersist();
        this.emit({ type: 'change' });
        return;
      }
      if (this.readOnly) return;
      this.local.set(doc.clientID, Y.getState(doc.store, doc.clientID));
      this.outbox.push(update);
      this.outboxTimer ??= setTimeout(() => this.flushOutbox(), updateBatchMs);
      this.emit({ type: 'local' });
      this.afterStateChange();
    };
    const title = doc.getText('title');
    const onTitle = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.origin !== titleOrigin) this.emit({ type: 'title', title: title.toString() });
    };
    doc.on('update', onUpdate);
    title.observe(onTitle);
    this.unbind = () => { doc.off('update', onUpdate); title.unobserve(onTitle); };
  }

  private afterStateChange(): void {
    this.schedulePersist();
    this.scheduleSave();
    for (const waiter of [...this.waiters]) waiter();
    this.emit({ type: 'change' });
  }

  private record(): RoomRecord {
    return {
      key: this.key(), userId: this.options.userId, workspaceId: this.options.workspaceId, pageId: this.options.pageId,
      epoch: this.epoch!, baseRevision: this.baseRevision ?? '0', title: this.titleText(),
      update: Y.encodeStateAsUpdate(this.doc!), local: [...this.local], acked: [...this.acked],
      updatedAt: new Date().toISOString(),
    };
  }

  private key(): string {
    return roomRecordKey(this.options.userId, this.options.workspaceId, this.options.pageId, this.epoch ?? 0);
  }

  private schedulePersist(): void {
    if (this.phase === 'ended' || this.readOnly) return;
    this.persistTimer ??= setTimeout(() => { this.persistTimer = undefined; this.persistNow(); }, persistDebounceMs);
  }

  // --- Outgoing -----------------------------------------------------------------------------------------------

  private flushOutbox(): void {
    this.outboxTimer = undefined;
    const updates = this.outbox;
    this.outbox = [];
    if (!updates.length || !this.connected) return;
    this.sendUpdate(updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates));
  }

  /** False when the update is too large for one frame: the room cannot carry it and the page falls back. */
  private sendUpdate(update: Uint8Array): boolean {
    if (update.byteLength + roomFrameHeaderBytes > roomFrameByteLimit) {
      const unsaved = this.record();
      this.end();
      this.emit({ type: 'fallback', code: 'TOO_LARGE', unsaved });
      return false;
    }
    this.sendFrame(roomFrameKinds.update, update);
    return true;
  }

  private queueAwareness(): void {
    this.awarenessDirty = true;
    this.awarenessTimer ??= setTimeout(() => {
      this.awarenessTimer = undefined;
      if (!this.awarenessDirty || !this.awareness || !this.doc) return;
      this.awarenessDirty = false;
      this.sendAwareness(this.awareness, this.doc.clientID);
    }, awarenessBatchMs);
  }

  private sendAwareness(awareness: Awareness, client: number): void {
    if (this.connected) this.sendFrame(roomFrameKinds.awareness, encodeAwarenessUpdate(awareness, [client]));
  }

  private sendFrame(kind: RoomFrame['kind'], payload: Uint8Array): void {
    if (this.epoch === null || !this.transport) return;
    this.transport.send(encodeRoomFrame({ kind, pageId: this.options.pageId, epoch: this.epoch, payload }));
  }

  // --- Saving (saver only) ------------------------------------------------------------------------------------

  private needsSave(): boolean {
    const doc = this.doc;
    if (!doc) return false;
    const vector = Y.decodeStateVector(Y.encodeStateVector(doc));
    if (covers(this.saved, vector)) return false;
    // A write already claimed exactly this state while the server held all of it; its `roomSaved` is on the way.
    const submitted = this.submitted;
    return !(submitted?.complete && covers(submitted.vector, vector));
  }

  private scheduleSave(): void {
    if (!this.options.save || !this.saver || this.readOnly || !this.connected || !this.synced || this.phase !== 'ready') return;
    if (this.saving) { this.saveAgain = true; return; }
    if (!this.needsSave()) { this.dirtySince = null; return; }
    const now = Date.now();
    this.dirtySince ??= now;
    clearTimeout(this.saveTimer);
    const delay = Math.max(0, Math.min(saveDebounceMs, this.dirtySince + saveMaxWaitMs - now));
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.saveNow(); }, delay);
  }

  private saveNow(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (this.saving) { this.saveAgain = true; return this.saving; }
    const save = this.options.save;
    const doc = this.doc;
    const epoch = this.epoch;
    if (!save || !doc || epoch === null || !this.saver || this.readOnly || !this.needsSave()) return Promise.resolve();
    this.saveAgain = false;
    let claimed: StateVector | null = null;
    let complete = false;
    const run = (async () => {
      let result: RoomSaveResult;
      try {
        result = await save(epoch, () => {
          const vector = Y.encodeStateVector(doc);
          claimed = Y.decodeStateVector(vector);
          complete = covers(this.acked, this.local);
          return vector;
        });
      } catch { result = 'retry'; }
      if (this.phase === 'ended' || this.epoch !== epoch) return;
      if (result === 'saved' && claimed) {
        this.submitted = { vector: claimed, complete };
        this.dirtySince = null;
        this.setSaveFailed(false);
      } else if (result === 'invalid') {
        this.setSaveFailed(true);
      } else if (result === 'retry') {
        this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.scheduleSave(); }, saveRetryMs);
      }
      this.emit({ type: 'change' });
    })().finally(() => {
      this.saving = null;
      if (this.saveAgain && this.phase !== 'ended') { this.saveAgain = false; this.scheduleSave(); }
    });
    this.saving = run;
    return run;
  }

  private setSaveFailed(failed: boolean): void {
    if (this.saveFailed === failed) return;
    this.saveFailed = failed;
    const awareness = this.provider?.awareness ?? null;
    if (awareness?.getLocalState()) awareness.setLocalStateField('saveFailed', failed);
  }

  private peerSaveFailed(): boolean {
    const states = this.awareness?.getStates();
    if (!states) return false;
    for (const [client, state] of states) if (client !== this.doc?.clientID && (state as { saveFailed?: unknown }).saveFailed === true) return true;
    return false;
  }

  // --- Teardown -----------------------------------------------------------------------------------------------

  private end(): void {
    if (this.phase === 'ended') return;
    if (this.persistTimer !== undefined) this.persistNow();
    this.phase = 'ended';
    clearTimeout(this.offlineTimer); clearTimeout(this.saveTimer); clearTimeout(this.outboxTimer); clearTimeout(this.awarenessTimer);
    clearTimeout(this.waitingTimer);
    this.outboxTimer = undefined; this.awarenessTimer = undefined; this.waitingTimer = undefined;
    if (this.outbox.length && this.connected) {
      const updates = this.outbox;
      this.outbox = [];
      const merged = Y.mergeUpdates(updates);
      if (merged.byteLength + roomFrameHeaderBytes <= roomFrameByteLimit) this.sendFrame(roomFrameKinds.update, merged);
    }
    if (this.awareness?.getLocalState() && this.doc) {
      this.awareness.setLocalState(null);
      this.sendAwareness(this.awareness, this.doc.clientID);
    }
    this.unbind?.();
    this.unbind = null;
    this.transport?.close();
    this.transport = null;
    this.connected = false;
    for (const waiter of [...this.waiters]) waiter();
  }

  private emit(event: RoomEvent): void {
    this.options.onEvent(event);
  }
}
