import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { AttachmentMetadata } from '@nbase/contracts';
import type { Pool, PoolClient } from 'pg';

export const maxAttachmentBytes = 10 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StoredAttachment {
  id: string;
  workspace_id: string;
  uploader_user_id: string;
  file_name: string;
  media_type: string;
  byte_size: number;
  sha256: Buffer;
  created_at: Date;
}

export class AttachmentError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string) { super(code); }
}

export function isAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

type AcceptedFile = { mediaType: string; extension: string; inline: boolean };
function identifyFile(bytes: Buffer, name: string): AcceptedFile {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { mediaType: 'image/png', extension: '.png', inline: true };
  }
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) {
    return { mediaType: 'image/jpeg', extension: '.jpg', inline: true };
  }
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return { mediaType: 'image/gif', extension: '.gif', inline: true };
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mediaType: 'image/webp', extension: '.webp', inline: true };
  }
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    return { mediaType: 'application/pdf', extension: '.pdf', inline: false };
  }
  if (bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))
    || bytes.subarray(0, 4).equals(Buffer.from('504b0506', 'hex'))) {
    return { mediaType: 'application/zip', extension: '.zip', inline: false };
  }
  if (/\.(?:txt|md)$/i.test(name) && !bytes.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { mediaType: /\.md$/i.test(name) ? 'text/markdown' : 'text/plain',
        extension: /\.md$/i.test(name) ? '.md' : '.txt', inline: false };
    } catch { /* Reject binary data disguised as text. */ }
  }
  throw new AttachmentError(415, 'ATTACHMENT_TYPE_UNSUPPORTED');
}

function safeFileName(value: unknown, kind: AcceptedFile): string {
  if (typeof value !== 'string' || !value || value.length > 180
    || /[\\/\u0000-\u001f\u007f]/.test(value) || value === '.' || value === '..'
    || value.trim() !== value || /[. ]$/.test(value) || value.includes(':')) {
    throw new AttachmentError(400, 'ATTACHMENT_NAME_INVALID');
  }
  const name = value.includes('.') ? value : `${value}${kind.extension}`;
  const suffix = name.slice(name.lastIndexOf('.')).toLowerCase();
  const permitted = kind.mediaType === 'image/jpeg' ? ['.jpg', '.jpeg'] : [kind.extension];
  if (!permitted.includes(suffix) || name.length > 180) throw new AttachmentError(415, 'ATTACHMENT_TYPE_MISMATCH');
  return name;
}

function metadata(row: StoredAttachment): AttachmentMetadata {
  return { id: row.id, workspaceId: row.workspace_id, fileName: row.file_name,
    mediaType: row.media_type, byteSize: row.byte_size, sha256: row.sha256.toString('hex'),
    createdAt: row.created_at.toISOString() };
}

function filePath(root: string, workspaceId: string, id: string): string {
  // Both components are UUIDs verified by route authorization and this repository.
  if (!isAttachmentId(workspaceId) || !isAttachmentId(id)) throw new AttachmentError(404, 'NOT_FOUND');
  return join(root, `${workspaceId.toLowerCase()}-${id.toLowerCase()}`);
}

/** Fail startup before opening a listener when the attachment volume is absent or unwritable. */
export async function prepareAttachmentDirectory(value: string, staticRoot: string): Promise<string> {
  if (!isAbsolute(value)) throw new Error('NBASE_ATTACHMENT_DIR must be an absolute path');
  const info = await stat(value).catch(() => null);
  if (!info?.isDirectory()) throw new Error('NBASE_ATTACHMENT_DIR must be an existing directory');
  const root = await realpath(value);
  const web = await realpath(staticRoot).catch(() => resolve(staticRoot));
  const withinWeb = relative(web, root);
  if (withinWeb === '' || (!withinWeb.startsWith('..') && !isAbsolute(withinWeb))) {
    throw new Error('NBASE_ATTACHMENT_DIR must be outside the public web directory');
  }
  const probe = join(root, `.nbase-write-check-${randomUUID()}`);
  const handle = await open(probe, 'wx');
  await handle.close();
  await unlink(probe);
  return root;
}

export class PgAttachmentRepository {
  constructor(private readonly pool: Pool, private readonly root: string) {}

  async get(workspaceId: string, id: string): Promise<AttachmentMetadata | null> {
    if (!isAttachmentId(workspaceId) || !isAttachmentId(id)) return null;
    const result = await this.pool.query<StoredAttachment>(
      'SELECT * FROM attachments WHERE workspace_id = $1 AND id = $2', [workspaceId, id]);
    return result.rows[0] ? metadata(result.rows[0]) : null;
  }

  async bytes(workspaceId: string, attachment: AttachmentMetadata): Promise<Buffer> {
    const path = filePath(this.root, workspaceId, attachment.id);
    let bytes: Buffer;
    try { bytes = await readFile(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AttachmentError(503, 'ATTACHMENT_MISSING');
      throw error;
    }
    if (bytes.length !== attachment.byteSize
      || createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) {
      throw new AttachmentError(503, 'ATTACHMENT_CORRUPT');
    }
    return bytes;
  }

  async save(workspaceId: string, actorId: string, id: string, rawName: unknown,
    bytes: Buffer): Promise<{ attachment: AttachmentMetadata; created: boolean }> {
    if (!isAttachmentId(workspaceId) || !isAttachmentId(actorId) || !isAttachmentId(id)) {
      throw new AttachmentError(404, 'NOT_FOUND');
    }
    if (!bytes.length) throw new AttachmentError(400, 'ATTACHMENT_EMPTY');
    if (bytes.length > maxAttachmentBytes) throw new AttachmentError(413, 'ATTACHMENT_TOO_LARGE');
    const kind = identifyFile(bytes, String(rawName ?? ''));
    const fileName = safeFileName(rawName, kind);
    const digest = createHash('sha256').update(bytes).digest();
    const path = filePath(this.root, workspaceId, id);
    const client: PoolClient = await this.pool.connect();
    let transactionOpen = false;
    let promoted = false;
    let commitAttempted = false;
    let temporary: string | null = null;
    try {
      await client.query('BEGIN'); transactionOpen = true;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${workspaceId}:${id}`]);
      const result = await client.query<StoredAttachment>(
        'SELECT * FROM attachments WHERE workspace_id = $1 AND id = $2', [workspaceId, id]);
      const existing = result.rows[0];
      if (existing) {
        if (existing.uploader_user_id !== actorId || existing.file_name !== fileName
          || existing.media_type !== kind.mediaType || existing.byte_size !== bytes.length
          || !existing.sha256.equals(digest)) throw new AttachmentError(409, 'ATTACHMENT_ID_CONFLICT');
        await this.bytes(workspaceId, metadata(existing));
        await client.query('COMMIT'); transactionOpen = false;
        return { attachment: metadata(existing), created: false };
      }
      // A crash after promotion but before DB commit leaves an orphan. Adopt only identical bytes.
      const orphan = await readFile(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (orphan) {
        if (!orphan.equals(bytes)) throw new AttachmentError(409, 'ATTACHMENT_ID_CONFLICT');
      } else {
        temporary = join(this.root, `.nbase-upload-${randomUUID()}`);
        await writeFile(temporary, bytes, { flag: 'wx' });
        await rename(temporary, path);
        temporary = null;
        promoted = true;
      }
      const inserted = await client.query<StoredAttachment>(`
        INSERT INTO attachments (id, workspace_id, uploader_user_id, file_name, media_type, byte_size, sha256)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, workspaceId, actorId, fileName, kind.mediaType, bytes.length, digest]);
      commitAttempted = true;
      await client.query('COMMIT'); transactionOpen = false;
      return { attachment: metadata(inserted.rows[0]!), created: true };
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
      if (temporary) await unlink(temporary).catch(() => {});
      // A failed COMMIT may have succeeded server-side; preserve the file for an idempotent retry.
      if (promoted && !commitAttempted) await unlink(path).catch(() => {});
      throw error;
    } finally { client.release(); }
  }
}
