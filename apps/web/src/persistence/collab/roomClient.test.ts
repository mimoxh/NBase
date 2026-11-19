import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { bytesToBase64, decodeRoomFrame, roomFrameKinds, type RoomFrame, type RoomServerMessage } from '@nbase/contracts';
import { RoomClient, type RoomEvent, type RoomHandler, type RoomTransport } from './roomClient';
import { memoryRoomStore, roomRecordKey, type RoomRecord, type RoomStore } from './roomStore';

const user = { userId: 'u2', loginName: '乙' };

function uuid(): string { return crypto.randomUUID(); }

/** A scripted room connection: records outgoing frames, delivers messages and frames by hand. */
function fakeChannel() {
  const sent: RoomFrame[] = [];
  let handler: RoomHandler | null = null;
  const transport: RoomTransport = {
    send: bytes => { const frame = decodeRoomFrame(bytes); if (frame) sent.push(frame); return true; },
    isOpen: () => true,
    close: () => undefined,
  };
  return {
    sent,
    connect: (next: RoomHandler) => { handler = next; return transport; },
    message: (message: RoomServerMessage) => handler!.message(message),
    frame: (kind: RoomFrame['kind'], pageId: string, epoch: number, payload: Uint8Array) =>
      handler!.frame({ kind, pageId, epoch, payload }),
    frames: (kind: RoomFrame['kind']) => sent.filter(frame => frame.kind === kind),
  };
}

function roomMessage(pageId: string, epoch: number, over: Partial<Extract<RoomServerMessage, { t: 'room' }>> = {}): RoomServerMessage {
  return { t: 'room', pageId, epoch, baseRevision: '3', savedRevision: null, savedStateVector: null,
    seed: true, saver: true, readOnly: false, ...over };
}

function setup(options: {
  pageId?: string; canWrite?: boolean; store?: RoomStore; offlineAfterMs?: number;
  save?: (epoch: number, stateVector: () => Uint8Array) => Promise<'saved' | 'stale' | 'invalid' | 'retry' | 'unavailable'>;
} = {}) {
  const pageId = options.pageId ?? uuid();
  const channel = fakeChannel();
  const events: RoomEvent[] = [];
  const client = new RoomClient({
    userId: 'u1', workspaceId: 'w1', pageId, canWrite: options.canWrite ?? true,
    store: options.store ?? memoryRoomStore(), connect: channel.connect,
    onEvent: event => events.push(event), ...(options.save ? { save: options.save } : {}),
    ...(options.offlineAfterMs !== undefined ? { offlineAfterMs: options.offlineAfterMs } : {}),
  });
  client.start();
  return { client, channel, events, pageId };
}

/** Joins epoch 5 and finishes the state exchange. */
async function joinReady(ctx: ReturnType<typeof setup>, epoch = 5, over: Parameters<typeof roomMessage>[2] = {}) {
  await vi.advanceTimersByTimeAsync(0);
  ctx.channel.message(roomMessage(ctx.pageId, epoch, over));
  ctx.channel.frame(roomFrameKinds.state, ctx.pageId, epoch, Y.encodeStateVector(new Y.Doc()));
  await vi.advanceTimersByTimeAsync(0);
  return epoch;
}

describe('room client', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('joins, answers the room with its state vector and turns ready for seeding', async () => {
    const ctx = setup();
    await joinReady(ctx);
    expect(ctx.client.epoch).toBe(5);
    expect(ctx.client.phase).toBe('ready');
    expect(ctx.client.saver).toBe(true);
    expect(ctx.channel.sent[0]?.kind).toBe(roomFrameKinds.state);
  });

  it('seeds an empty room through the editor provider: sync event plus the opening title', async () => {
    const ctx = setup();
    await joinReady(ctx);
    const { doc, provider } = ctx.client.attach('页面标题');
    let synced: unknown = null;
    provider.on('sync', value => { synced = value; });
    provider.connect();
    expect(synced).toBe(true);
    expect(doc.getText('title').toString()).toBe('页面标题');
    provider.disconnect();
  });

  it('binds an editor that connected before the room had a document', async () => {
    const ctx = setup();
    await vi.advanceTimersByTimeAsync(0);
    const { provider } = ctx.client.attach('晚到的编辑器');
    let synced: unknown = null;
    provider.on('sync', value => { synced = value; });
    provider.connect();
    await joinReady(ctx);
    expect(synced).toBe(true);
    expect(ctx.client.titleText()).toBe('晚到的编辑器');
  });

  it('sends local edits as updates and tracks the server ack', async () => {
    const ctx = setup();
    await joinReady(ctx);
    const doc = ctx.client.doc!;
    doc.getMap('m').set('a', 1);
    expect(ctx.client.hasUnacked()).toBe(true);
    await vi.advanceTimersByTimeAsync(60);
    const updates = ctx.channel.frames(roomFrameKinds.update);
    expect(updates.length).toBe(1);
    ctx.channel.frame(roomFrameKinds.ack, ctx.pageId, 5, Y.encodeStateVector(doc));
    expect(ctx.client.hasUnacked()).toBe(false);
  });

  it('keeps remote edits queued while an input method composes text', async () => {
    const ctx = setup();
    await joinReady(ctx);
    const other = new Y.Doc();
    other.getMap('m').set('y', 2);
    const update = Y.encodeStateAsUpdate(other, Y.encodeStateVector(ctx.client.doc!));
    ctx.client.hold(true);
    ctx.channel.frame(roomFrameKinds.update, ctx.pageId, 5, update);
    expect(ctx.client.doc!.getMap('m').get('y')).toBeUndefined();
    ctx.client.hold(false);
    expect(ctx.client.doc!.getMap('m').get('y')).toBe(2);
  });

  it('saves as the saver after the debounce and settles when the room confirms', async () => {
    let claimed: Uint8Array | null = null;
    const ctx = setup({ save: async (_epoch, stateVector) => { claimed = stateVector(); return 'saved'; } });
    await joinReady(ctx);
    ctx.client.doc!.getMap('m').set('a', 1);
    await vi.advanceTimersByTimeAsync(1600);
    expect(claimed).not.toBeNull();
    expect(ctx.client.hasLocalUnsaved()).toBe(true);
    ctx.channel.message({ t: 'roomSaved', pageId: ctx.pageId, epoch: 5, revision: '4',
      stateVector: bytesToBase64(claimed!), by: user });
    expect(ctx.client.hasLocalUnsaved()).toBe(false);
    expect(ctx.client.status()).toBe('已保存');
    expect(ctx.events.some(event => event.type === 'saved' && event.revision === '4')).toBe(true);
  });

  it('reports 已同步，等待保存 once the server has the edits but no revision does', async () => {
    const ctx = setup();
    await joinReady(ctx);
    const doc = ctx.client.doc!;
    doc.getMap('m').set('a', 1);
    await vi.advanceTimersByTimeAsync(60);
    ctx.channel.frame(roomFrameKinds.ack, ctx.pageId, 5, Y.encodeStateVector(doc));
    expect(ctx.client.status()).toBe('已同步，等待保存');
  });

  it('reloads on a room reset when nothing local is unconfirmed', async () => {
    const ctx = setup();
    await joinReady(ctx);
    ctx.channel.message({ t: 'roomReset', pageId: ctx.pageId, epoch: 9, revision: '4', reason: 'restore', by: user });
    const reload = ctx.events.find(event => event.type === 'reload');
    expect(reload).toMatchObject({ reason: 'restore', by: user });
    expect(ctx.client.phase).toBe('ended');
  });

  it('ignores a reset notice for the current epoch', async () => {
    const ctx = setup();
    await joinReady(ctx);
    ctx.channel.message({ t: 'roomReset', pageId: ctx.pageId, epoch: 5, revision: '4', reason: 'restore', by: user });
    expect(ctx.events.some(event => event.type === 'reload' || event.type === 'conflict')).toBe(false);
    expect(ctx.client.phase).toBe('ready');
  });

  it('keeps unconfirmed local changes as a conflict record when the room resets', async () => {
    const store = memoryRoomStore();
    const ctx = setup({ store });
    await joinReady(ctx);
    ctx.client.doc!.getMap('m').set('a', 1);
    await vi.advanceTimersByTimeAsync(60);
    ctx.channel.message({ t: 'roomReset', pageId: ctx.pageId, epoch: 9, revision: '4', reason: 'restore', by: user });
    const conflict = ctx.events.find(event => event.type === 'conflict');
    expect(conflict).toBeDefined();
    const stored = await store.forPage('u1', 'w1', ctx.pageId);
    expect(stored.length).toBe(1);
    expect(stored[0]!.epoch).toBe(5);
  });

  it('opens the newest stored copy when the server stays silent', async () => {
    const pageId = uuid();
    const store = memoryRoomStore();
    const source = new Y.Doc();
    source.getText('title').insert(0, '离线标题');
    source.getMap('m').set('x', 1);
    const record: RoomRecord = {
      key: roomRecordKey('u1', 'w1', pageId, 7), userId: 'u1', workspaceId: 'w1', pageId, epoch: 7,
      baseRevision: '3', title: '离线标题', update: Y.encodeStateAsUpdate(source),
      local: [[source.clientID, Y.getState(source.store, source.clientID)]], acked: [],
      updatedAt: new Date().toISOString(),
    };
    await store.put(record);
    const ctx = setup({ pageId, store, offlineAfterMs: 30 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.client.phase).toBe('ready');
    expect(ctx.client.epoch).toBe(7);
    expect(ctx.client.titleText()).toBe('离线标题');
    expect(ctx.client.doc!.getMap('m').get('x')).toBe(1);
    expect(ctx.client.status()).toBe('离线，修改保存在本机');
  });

  it('falls back without a stored copy when the server stays silent', async () => {
    const ctx = setup({ offlineAfterMs: 30 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.events.some(event => event.type === 'fallback' && event.code === 'OFFLINE')).toBe(true);
  });

  it('falls back on a room error and carries unsaved changes in the event', async () => {
    const ctx = setup();
    await joinReady(ctx);
    ctx.client.doc!.getMap('m').set('a', 1);
    ctx.channel.message({ t: 'roomError', pageId: ctx.pageId, code: 'REALTIME_DISABLED' });
    const fallback = ctx.events.find(event => event.type === 'fallback');
    expect(fallback).toMatchObject({ code: 'REALTIME_DISABLED' });
    expect(fallback && fallback.type === 'fallback' ? fallback.unsaved : null).not.toBeNull();
  });

  it('reports remote title edits and rewrites its own title with a minimal diff', async () => {
    const ctx = setup();
    await joinReady(ctx);
    const { provider } = ctx.client.attach('原标题');
    provider.connect();
    expect(ctx.client.titleText()).toBe('原标题');
    ctx.client.setTitle('新标题');
    expect(ctx.client.titleText()).toBe('新标题');
    expect(ctx.events.filter(event => event.type === 'title').length).toBe(0);
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(ctx.client.doc!));
    other.getText('title').insert(0, '别人的');
    ctx.channel.frame(roomFrameKinds.update, ctx.pageId, 5,
      Y.encodeStateAsUpdate(other, Y.encodeStateVector(ctx.client.doc!)));
    expect(ctx.client.titleText()).toBe('别人的新标题');
    expect(ctx.events.some(event => event.type === 'title' && event.title === '别人的新标题')).toBe(true);
  });

  it('gives up on a room that stays empty because nobody can seed it', async () => {
    const ctx = setup({ canWrite: false });
    await joinReady(ctx, 5, { seed: false, saver: false, readOnly: true });
    expect(ctx.client.phase).toBe('waiting');
    await vi.advanceTimersByTimeAsync(12_500);
    expect(ctx.events.some(event => event.type === 'fallback' && event.code === 'OFFLINE')).toBe(true);
  });

  it('follows the room read-only as a viewer and never sends updates', async () => {
    const ctx = setup({ canWrite: false });
    await joinReady(ctx, 5, { seed: false, saver: false, readOnly: true });
    expect(ctx.client.readOnly).toBe(true);
    ctx.client.doc!.getMap('m').set('a', 1);
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.channel.frames(roomFrameKinds.update).length).toBe(0);
  });
});
