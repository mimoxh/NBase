/** Real-time co-editing rooms (docs/architecture/realtime.md). Shared by the server and the web client. */
import type { MemberRef } from './collaboration.js';

/** Header of a binary room frame: kind (1 byte), page id (16 bytes), epoch (4 bytes, big-endian). */
export const roomFrameHeaderBytes = 21;
export const roomFrameByteLimit = 256 * 1024;
export const roomFramesPerSecond = 50;
/** The open page plus the embedded pages it shows. */
export const roomSubscriptionLimit = 13;

export const roomFrameKinds = {
  /** Payload is the sender's Yjs state vector; the receiver answers with the update the sender lacks. */
  state: 0,
  /** Payload is a Yjs update. */
  update: 1,
  /** Payload is a y-protocols awareness update. */
  awareness: 2,
  /** Server to client: payload is the room's state vector after the client's update was stored. */
  ack: 3,
} as const;
export type RoomFrameKind = (typeof roomFrameKinds)[keyof typeof roomFrameKinds];

export interface RoomFrame { kind: RoomFrameKind; pageId: string; epoch: number; payload: Uint8Array }

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeRoomFrame(frame: RoomFrame): Uint8Array {
  const pageId = frame.pageId.toLowerCase();
  if (!uuidPattern.test(pageId)) throw new Error('Invalid room page id');
  const bytes = new Uint8Array(roomFrameHeaderBytes + frame.payload.byteLength);
  bytes[0] = frame.kind;
  const hex = pageId.replaceAll('-', '');
  for (let index = 0; index < 16; index++) bytes[1 + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  new DataView(bytes.buffer).setUint32(17, frame.epoch >>> 0);
  bytes.set(frame.payload, roomFrameHeaderBytes);
  return bytes;
}

export function decodeRoomFrame(bytes: Uint8Array): RoomFrame | null {
  if (bytes.byteLength < roomFrameHeaderBytes || bytes.byteLength > roomFrameByteLimit) return null;
  const kind = bytes[0]!;
  if (kind > roomFrameKinds.ack) return null;
  let hex = '';
  for (let index = 1; index < 17; index++) hex += bytes[index]!.toString(16).padStart(2, '0');
  const pageId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const epoch = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(17);
  if (epoch === 0) return null;
  return { kind: kind as RoomFrameKind, pageId, epoch, payload: bytes.subarray(roomFrameHeaderBytes) };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Sent with a page write made by a room's saver. */
export interface CollabWrite {
  epoch: number;
  /** Base64 Yjs state vector of the document the saver turned into this content. */
  stateVector: string;
}
export const collabStateVectorLimit = 64 * 1024;

export type RoomResetReason = 'restore' | 'source' | 'write' | 'rebuild';
export type RoomErrorCode = 'NOT_FOUND' | 'PAGE_KIND_INVALID' | 'ROOM_LIMIT' | 'SERVICE_UNAVAILABLE' | 'REALTIME_DISABLED';

export type RoomServerMessage =
  | { t: 'room'; pageId: string; epoch: number; baseRevision: string; savedRevision: string | null;
    savedStateVector: string | null; seed: boolean; saver: boolean; readOnly: boolean }
  | { t: 'roomRole'; pageId: string; epoch: number; seed: boolean; saver: boolean }
  | { t: 'roomSaved'; pageId: string; epoch: number; revision: string; stateVector: string; by: MemberRef }
  | { t: 'roomReset'; pageId: string; epoch: number; revision: string; reason: RoomResetReason; by: MemberRef | null }
  | { t: 'roomError'; pageId: string; code: RoomErrorCode };
