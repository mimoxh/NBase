import { createHash, randomUUID } from 'node:crypto';
import type { CreatePageRequest, PageDocument, PageHistoryResponse, PageListResponse, PageStateRequest,
  PageSummary, PageVersion, PageVersionOperation, PageVersionSummary, RestorePageVersionRequest,
  SearchResponse, TrashedPageDocument, TrashListResponse, TrashPageRequest, UpdatePageRequest } from '@nbase/contracts';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { attachmentReferences, validateDocumentContent } from './validate.js';
import { extractSearchText } from './search-text.js';

const maxRevision = 9223372036854775807n;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

export function isRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= maxRevision;
}

export class PageError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'REVISION_CONFLICT' | 'MUTATION_CONFLICT'
      | 'PAGE_TREE_INVALID' | 'PAGE_TREE_CHANGED' | 'CONTENT_VERSION_UNSUPPORTED' | 'ATTACHMENT_INVALID',
    public readonly currentRevision?: string,
  ) { super(code); }

  response(): { error: PageError['code']; currentRevision?: string } {
    return this.currentRevision ? { error: this.code, currentRevision: this.currentRevision } : { error: this.code };
  }
}

interface PageRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  title: string;
  content_json: PageDocument['content'];
  content_schema_version: number;
  revision: string;
  created_at: Date;
  updated_at: Date;
  cursor_created_at?: string;
}

interface ReceiptRow {
  operation: string;
  request_hash: Buffer;
  response_status: number;
  response_json: PageDocument;
}

interface VersionRow {
  page_id: string; revision: string; title: string; parent_id: string | null;
  content_json: PageDocument['content']; saved_at: Date; operation: PageVersionOperation;
  deleted_at: Date | null;
}

interface TrashRow extends PageRow {
  deleted_at: Date; deletion_group_id: string; cursor_deleted_at?: string;
}

function versionSummary(row: VersionRow): PageVersionSummary {
  return { revision: row.revision, title: row.title, savedAt: row.saved_at.toISOString(),
    operation: row.operation, deleted: row.deleted_at !== null };
}

export interface MutationResult<T> {
  statusCode: number;
  body: T;
}

function pageFromRow(row: PageRow): PageDocument {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    parentId: row.parent_id,
    title: row.title,
    content: row.content_json,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function summaryFromRow(row: PageRow): PageSummary {
  const { content: _content, ...summary } = pageFromRow(row);
  void _content;
  return summary;
}

function searchSnippet(text: string, phrase: string): string {
  if (!text) return '仅标题匹配';
  const at = text.toLocaleLowerCase().indexOf(phrase.toLocaleLowerCase());
  const start = Math.max(0, (at < 0 ? 0 : at) - 45);
  const end = Math.min(text.length, (at < 0 ? 0 : at + phrase.length) + 85);
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** Object key order is irrelevant to an idempotency replay. Never turn parsed JSON into an object via assignment. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestHash(operation: string, pageId: string | null, body: unknown): Buffer {
  return createHash('sha256').update(canonicalJson({ operation, pageId, body })).digest();
}

const pageColumns = `id, workspace_id, parent_id, title, content_json, content_schema_version, revision::text AS revision,
  created_at, updated_at`;
const joinedPageColumns = `p.id, p.workspace_id, p.parent_id, p.title, p.content_json, p.content_schema_version,
  p.revision::text AS revision, p.created_at, p.updated_at`;

export class PgPageRepository {
  constructor(private readonly pool: Pool) {}

  private async snapshot(client: PoolClient, workspaceId: string, ids: string[], actorId: string,
    operation: PageVersionOperation): Promise<void> {
    await client.query(`INSERT INTO page_versions (workspace_id, page_id, revision, title, parent_id,
      content_json, content_schema_version, deleted_at, saved_at, actor_user_id, operation)
      SELECT workspace_id, id, revision, title, parent_id, content_json, content_schema_version,
        deleted_at, updated_at, $3, $4 FROM pages WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
    [workspaceId, ids, actorId, operation]);
  }

  async history(workspaceId: string, actorId: string, pageId: string, limit: number,
    before: string | null): Promise<PageHistoryResponse> {
    const result = await this.pool.query<VersionRow>(`SELECT h.revision::text AS revision, h.title,
      h.saved_at, h.operation, h.deleted_at FROM page_versions h
      JOIN workspace_memberships m ON m.workspace_id = h.workspace_id AND m.user_id = $2
      WHERE h.workspace_id = $1 AND h.page_id = $3 AND ($4::bigint IS NULL OR h.revision < $4)
      ORDER BY h.revision DESC LIMIT $5`, [workspaceId, actorId, pageId, before, limit + 1]);
    const visible = result.rows.slice(0, limit);
    return { versions: visible.map(versionSummary),
      nextBeforeRevision: result.rows.length > limit ? visible.at(-1)!.revision : null };
  }

  async version(workspaceId: string, actorId: string, pageId: string, revision: string): Promise<PageVersion | null> {
    const result = await this.pool.query<VersionRow>(`SELECT h.page_id, h.revision::text AS revision,
      h.title, h.parent_id, h.content_json, h.saved_at, h.operation, h.deleted_at FROM page_versions h
      JOIN workspace_memberships m ON m.workspace_id = h.workspace_id AND m.user_id = $2
      WHERE h.workspace_id = $1 AND h.page_id = $3 AND h.revision = $4::bigint`,
    [workspaceId, actorId, pageId, revision]);
    const row = result.rows[0];
    return row ? { ...versionSummary(row), pageId: row.page_id, parentId: row.parent_id, content: row.content_json } : null;
  }

  async trashList(workspaceId: string, actorId: string, limit: number,
    cursor: { createdAt: string; id: string } | null): Promise<TrashListResponse> {
    const result = await this.pool.query<TrashRow>(`SELECT ${joinedPageColumns}, p.deleted_at,
      p.deletion_group_id, p.deleted_at::text AS cursor_deleted_at FROM pages p
      JOIN workspace_memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2
      WHERE p.workspace_id = $1 AND p.deleted_at IS NOT NULL
        AND ($3::timestamptz IS NULL OR (p.deleted_at, p.id) < ($3::timestamptz, $4::uuid))
      ORDER BY p.deleted_at DESC, p.id DESC LIMIT $5`,
    [workspaceId, actorId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]);
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return { pages: visible.map(row => ({ ...summaryFromRow(row),
      deletedAt: row.deleted_at.toISOString(), deletionGroupId: row.deletion_group_id })),
    nextCursor: result.rows.length > limit && last
      ? Buffer.from(JSON.stringify({ createdAt: last.cursor_deleted_at, id: last.id })).toString('base64url') : null };
  }

  async trashed(workspaceId: string, actorId: string, pageId: string): Promise<TrashedPageDocument | null> {
    const result = await this.pool.query<TrashRow>(`SELECT ${joinedPageColumns}, p.deleted_at,
      p.deletion_group_id FROM pages p
      JOIN workspace_memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2
      WHERE p.workspace_id = $1 AND p.id = $3 AND p.deleted_at IS NOT NULL`, [workspaceId, actorId, pageId]);
    const row = result.rows[0];
    return row ? { ...pageFromRow(row), deletedAt: row.deleted_at.toISOString(), deletionGroupId: row.deletion_group_id } : null;
  }

  async get(workspaceId: string, actorId: string, pageId: string): Promise<PageDocument | null> {
    const result = await this.pool.query<PageRow>(`
      SELECT ${joinedPageColumns} FROM pages p
      JOIN workspace_memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2
      WHERE p.workspace_id = $1 AND p.id = $3 AND p.deleted_at IS NULL
    `, [workspaceId, actorId, pageId]);
    return result.rows[0] ? pageFromRow(result.rows[0]) : null;
  }

  async list(workspaceId: string, actorId: string, parentId: string | null,
    limit: number, cursor: { createdAt: string; id: string } | null): Promise<PageListResponse> {
    const result = await this.pool.query<PageRow>(`
      SELECT ${joinedPageColumns}, p.created_at::text AS cursor_created_at FROM pages p
      JOIN workspace_memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2
      WHERE p.workspace_id = $1 AND p.parent_id IS NOT DISTINCT FROM $3::uuid AND p.deleted_at IS NULL
        AND ($4::timestamptz IS NULL OR (p.created_at, p.id) > ($4::timestamptz, $5::uuid))
      ORDER BY p.created_at, p.id LIMIT $6
    `, [workspaceId, actorId, parentId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]);
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      pages: visible.map(summaryFromRow),
      nextCursor: result.rows.length > limit && last
        ? Buffer.from(JSON.stringify({ createdAt: last.cursor_created_at, id: last.id })).toString('base64url')
        : null,
    };
  }

  async receipt(workspaceId: string, actorId: string, mutationId: string): Promise<MutationResult<PageDocument> | null> {
    const result = await this.pool.query<ReceiptRow>(`
      SELECT r.operation, r.request_hash, r.response_status, r.response_json
      FROM page_mutation_receipts r
      JOIN workspace_memberships m ON m.workspace_id = r.workspace_id AND m.user_id = $2
      WHERE r.workspace_id = $1 AND r.actor_user_id = $2 AND r.client_mutation_id = $3
    `, [workspaceId, actorId, mutationId]);
    const row = result.rows[0];
    return row ? { statusCode: row.response_status, body: row.response_json } : null;
  }

  async search(workspaceId: string, actorId: string, phrase: string, limit: number): Promise<SearchResponse> {
    const result = await this.pool.query<{ id: string; parent_id: string | null; title: string;
      revision: string; updated_at: Date; search_text: string; title_match: boolean }>(`
      SELECT p.id, p.parent_id, p.title, p.revision::text AS revision, p.updated_at, p.search_text,
        (position(lower($3) in lower(p.title)) > 0) AS title_match
      FROM pages p
      JOIN workspace_memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2
      WHERE p.workspace_id = $1 AND p.deleted_at IS NULL
        AND (position(lower($3) in lower(p.title)) > 0
          OR position(lower($3) in lower(p.search_text)) > 0)
      ORDER BY title_match DESC, p.updated_at DESC, p.id
      LIMIT $4
    `, [workspaceId, actorId, phrase, limit + 1]);
    return { results: result.rows.slice(0, limit).map(row => ({ pageId: row.id, title: row.title,
      parentId: row.parent_id, revision: row.revision, updatedAt: row.updated_at.toISOString(),
      snippet: searchSnippet(row.search_text, phrase), matchField: row.title_match ? 'title' as const : 'content' as const })),
    truncated: result.rows.length > limit };
  }

  private async mutate(
    workspaceId: string, actorId: string, mutationId: string, operation: string,
    pageId: string | null, body: unknown,
    action: (client: PoolClient) => Promise<MutationResult<PageDocument>>,
  ): Promise<MutationResult<PageDocument>> {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      // Serializes every tree mutation and same-key retry in this workspace.
      const membership = await client.query<{ role: string }>(`
        SELECT m.role FROM workspaces w
        JOIN workspace_memberships m ON m.workspace_id = w.id AND m.user_id = $2
        WHERE w.id = $1 FOR UPDATE OF w
      `, [workspaceId, actorId]);
      if (!membership.rows[0]) throw new PageError(404, 'NOT_FOUND');
      if (membership.rows[0].role === 'viewer') throw new PageError(403, 'FORBIDDEN');

      const hash = requestHash(operation, pageId, body);
      const prior = await client.query<ReceiptRow>(`
        SELECT operation, request_hash, response_status, response_json FROM page_mutation_receipts
        WHERE workspace_id = $1 AND actor_user_id = $2 AND client_mutation_id = $3
      `, [workspaceId, actorId, mutationId]);
      const receipt = prior.rows[0];
      if (receipt) {
        if (receipt.operation !== operation || !receipt.request_hash.equals(hash)) {
          throw new PageError(409, 'MUTATION_CONFLICT');
        }
        await client.query('COMMIT');
        transactionOpen = false;
        return { statusCode: receipt.response_status, body: receipt.response_json };
      }

      const result = await action(client);
      await client.query(`
        INSERT INTO page_mutation_receipts
          (workspace_id, actor_user_id, client_mutation_id, operation, request_hash, page_id, response_status, response_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `, [workspaceId, actorId, mutationId, operation, hash, result.body.id, result.statusCode, JSON.stringify(result.body)]);
      await client.query('COMMIT');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the original write error. */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async validateAttachments(client: PoolClient, workspaceId: string,
    content: PageDocument['content']): Promise<void> {
    const references = attachmentReferences(content);
    if (!references.length) return;
    const ids = [...new Set(references.map(item => item.id))];
    const result = await client.query<{ id: string; file_name: string; media_type: string }>(
      'SELECT id, file_name, media_type FROM attachments WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
      [workspaceId, ids]);
    const known = new Map(result.rows.map(row => [row.id, row]));
    if (references.some(item => {
      const row = known.get(item.id.toLowerCase());
      return !row || row.file_name !== item.fileName || row.media_type !== item.mediaType;
    })) throw new PageError(422, 'ATTACHMENT_INVALID');
  }

  async create(workspaceId: string, actorId: string, body: CreatePageRequest): Promise<MutationResult<PageDocument>> {
    return this.mutate(workspaceId, actorId, body.clientMutationId, 'create', null, body, async (client) => {
      await this.validateAttachments(client, workspaceId, body.content);
      if (body.parentId !== null) {
        const parent = await client.query(
          'SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL',
          [workspaceId, body.parentId],
        );
        if (!parent.rows[0]) throw new PageError(422, 'PAGE_TREE_INVALID');
      }
      const result = await client.query<PageRow>(`
        INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_schema_version, search_text)
        VALUES ($1, $2, $3, $4, $5::jsonb, 1, $6)
        RETURNING ${pageColumns}
      `, [randomUUID(), workspaceId, body.parentId, body.title, JSON.stringify(body.content), extractSearchText(body.content)]);
      await this.snapshot(client, workspaceId, [result.rows[0]!.id], actorId, 'create');
      return { statusCode: 201, body: pageFromRow(result.rows[0]!) };
    });
  }

  private async validateParent(client: PoolClient, workspaceId: string, pageId: string, parentId: string): Promise<void> {
    let candidate: string | null = parentId;
    const visited = new Set<string>();
    while (candidate !== null) {
      if (candidate === pageId || visited.has(candidate) || visited.size >= 64) {
        throw new PageError(422, 'PAGE_TREE_INVALID');
      }
      visited.add(candidate);
      const parent: QueryResult<{ parent_id: string | null }> = await client.query<{ parent_id: string | null }>(
        'SELECT parent_id FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL',
        [workspaceId, candidate],
      );
      if (!parent.rows[0]) throw new PageError(422, 'PAGE_TREE_INVALID');
      candidate = parent.rows[0].parent_id;
    }
  }

  async update(workspaceId: string, actorId: string, pageId: string,
    body: UpdatePageRequest): Promise<MutationResult<PageDocument>> {
    return this.mutate(workspaceId, actorId, body.clientMutationId, 'update', pageId, body, async (client) => {
      const existing = await client.query<PageRow>(`
        SELECT ${pageColumns} FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE
      `, [workspaceId, pageId]);
      const row = existing.rows[0];
      if (!row) throw new PageError(404, 'NOT_FOUND');
      if (row.content_schema_version !== 1) throw new PageError(422, 'CONTENT_VERSION_UNSUPPORTED');
      if (row.revision !== body.expectedRevision) throw new PageError(409, 'REVISION_CONFLICT', row.revision);
      if (body.content) await this.validateAttachments(client, workspaceId, body.content);
      const parentId = body.parentId === undefined ? row.parent_id : body.parentId;
      if (parentId !== null && parentId !== row.parent_id) await this.validateParent(client, workspaceId, pageId, parentId);

      const result = await client.query<PageRow>(`
        UPDATE pages SET title = $3, parent_id = $4, content_json = $5::jsonb,
          content_schema_version = 1, search_text = $7, revision = revision + 1, updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND revision = $6::bigint AND deleted_at IS NULL
        RETURNING ${pageColumns}
      `, [workspaceId, pageId, body.title ?? row.title, parentId,
        JSON.stringify(body.content ?? row.content_json), body.expectedRevision,
        body.content ? extractSearchText(body.content) : extractSearchText(row.content_json)]);
      if (!result.rows[0]) throw new PageError(409, 'REVISION_CONFLICT');
      await this.snapshot(client, workspaceId, [pageId], actorId, 'update');
      return { statusCode: 200, body: pageFromRow(result.rows[0]) };
    });
  }

  async trash(workspaceId: string, actorId: string, pageId: string,
    body: TrashPageRequest): Promise<MutationResult<PageDocument>> {
    return this.mutate(workspaceId, actorId, body.clientMutationId, 'trash', pageId, body, async (client) => {
      const existing = await client.query<PageRow>(`
        SELECT ${pageColumns} FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE
      `, [workspaceId, pageId]);
      const row = existing.rows[0];
      if (!row) throw new PageError(404, 'NOT_FOUND');
      if (row.revision !== body.expectedRevision) throw new PageError(409, 'REVISION_CONFLICT', row.revision);
      if (body.expectedSubtreeIds) {
        const actual = await client.query<{ id: string }>(`WITH RECURSIVE subtree AS (
          SELECT id FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
          UNION ALL SELECT child.id FROM pages child JOIN subtree parent ON child.parent_id = parent.id
          WHERE child.workspace_id = $1 AND child.deleted_at IS NULL
        ) SELECT id FROM subtree`, [workspaceId, pageId]);
        const expected = body.expectedSubtreeIds.map(id => id.toLowerCase()).sort();
        if (JSON.stringify(actual.rows.map(item => item.id).sort()) !== JSON.stringify(expected)) {
          throw new PageError(409, 'PAGE_TREE_CHANGED');
        }
      }
      const deleted = await client.query<PageRow>(`
        WITH RECURSIVE subtree AS (
          SELECT id FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
          UNION ALL
          SELECT child.id FROM pages child JOIN subtree parent ON child.parent_id = parent.id
          WHERE child.workspace_id = $1 AND child.deleted_at IS NULL
        )
        UPDATE pages p SET deleted_at = now(), deletion_group_id = $2,
          revision = revision + 1, updated_at = now()
        WHERE p.workspace_id = $1 AND p.id IN (SELECT id FROM subtree)
        RETURNING ${pageColumns}
      `, [workspaceId, pageId]);
      const root = deleted.rows.find(item => item.id === pageId);
      if (!root) throw new PageError(404, 'NOT_FOUND');
      await this.snapshot(client, workspaceId, deleted.rows.map(item => item.id), actorId, 'trash');
      return { statusCode: 200, body: pageFromRow(root) };
    });
  }

  async restore(workspaceId: string, actorId: string, pageId: string,
    body: PageStateRequest): Promise<MutationResult<PageDocument>> {
    return this.mutate(workspaceId, actorId, body.clientMutationId, 'restore', pageId, body, async (client) => {
      const existing = await client.query<PageRow & { deletion_group_id: string }>(`
        SELECT ${pageColumns}, deletion_group_id FROM pages
        WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NOT NULL FOR UPDATE
      `, [workspaceId, pageId]);
      const row = existing.rows[0];
      if (!row) throw new PageError(404, 'NOT_FOUND');
      if (row.revision !== body.expectedRevision) throw new PageError(409, 'REVISION_CONFLICT', row.revision);
      let parentId = row.parent_id;
      if (row.parent_id) {
        const parent = await client.query('SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL',
          [workspaceId, row.parent_id]);
        if (!parent.rows[0]) parentId = null;
      }
      const restored = await client.query<PageRow>(`
        WITH RECURSIVE subtree AS (
          SELECT id FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NOT NULL
          UNION ALL
          SELECT child.id FROM pages child JOIN subtree parent ON child.parent_id = parent.id
          WHERE child.workspace_id = $1 AND child.deleted_at IS NOT NULL AND child.deletion_group_id = $3
        )
        UPDATE pages SET deleted_at = NULL, deletion_group_id = NULL,
          parent_id = CASE WHEN id = $2 THEN $4::uuid ELSE parent_id END,
          revision = revision + 1, updated_at = now()
        WHERE workspace_id = $1 AND id IN (SELECT id FROM subtree)
        RETURNING ${pageColumns}
      `, [workspaceId, pageId, row.deletion_group_id, parentId]);
      const root = restored.rows.find(item => item.id === pageId);
      if (!root) throw new PageError(404, 'NOT_FOUND');
      await this.snapshot(client, workspaceId, restored.rows.map(item => item.id), actorId, 'restore');
      return { statusCode: 200, body: pageFromRow(root) };
    });
  }

  async restoreVersion(workspaceId: string, actorId: string, pageId: string,
    body: RestorePageVersionRequest): Promise<MutationResult<PageDocument>> {
    return this.mutate(workspaceId, actorId, body.clientMutationId, 'restore-version', pageId, body, async client => {
      const existing = await client.query<PageRow>(`SELECT ${pageColumns} FROM pages
        WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`, [workspaceId, pageId]);
      const current = existing.rows[0];
      if (!current) throw new PageError(404, 'NOT_FOUND');
      if (current.content_schema_version !== 1) throw new PageError(422, 'CONTENT_VERSION_UNSUPPORTED');
      if (current.revision !== body.expectedRevision) throw new PageError(409, 'REVISION_CONFLICT', current.revision);
      const source = await client.query<{ title: string; content_json: PageDocument['content'] }>(
        'SELECT title, content_json FROM page_versions WHERE workspace_id = $1 AND page_id = $2 AND revision = $3::bigint',
        [workspaceId, pageId, body.sourceRevision]);
      const version = source.rows[0];
      if (!version) throw new PageError(404, 'NOT_FOUND');
      const content = validateDocumentContent(version.content_json);
      await this.validateAttachments(client, workspaceId, content);
      const result = await client.query<PageRow>(`UPDATE pages SET title = $3, content_json = $4::jsonb,
        content_schema_version = 1, search_text = $5, revision = revision + 1, updated_at = now()
        WHERE workspace_id = $1 AND id = $2 RETURNING ${pageColumns}`,
      [workspaceId, pageId, version.title, JSON.stringify(content), extractSearchText(content)]);
      await this.snapshot(client, workspaceId, [pageId], actorId, 'restore-version');
      return { statusCode: 200, body: pageFromRow(result.rows[0]!) };
    });
  }
}

export function decodePageCursor(value: string): { createdAt: string; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return null;
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const data = parsed as Record<string, unknown>;
    if (typeof data.createdAt !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?[+-]\d\d(?::?\d\d)?$/.test(data.createdAt)
      || Number.isNaN(Date.parse(data.createdAt)) || !isUuid(data.id)) return null;
    return { createdAt: data.createdAt, id: data.id };
  } catch { return null; }
}
