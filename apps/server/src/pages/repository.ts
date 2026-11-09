import { createHash, randomUUID } from 'node:crypto';
import { databaseRowLimit, pageBacklinkLimit, type PageBacklinksResponse, type PageKind, type RowProperties } from '@nbase/contracts';
import { markRowsChanged } from '../databases/computed.js';
import { loadDatabaseSchema, mergeRowProperties, rowIndexText, syncRelationLinks } from '../databases/schema.js';
import type { CreatePageRequest, FavoriteListResponse, PageCoverId, PageDocument, PageHistoryResponse, PageListResponse, PageStateRequest,
  PageSummary, PageTreeResponse, PageVersion, PageVersionOperation, PageVersionSummary, RestorePageVersionRequest,
  SearchResponse, TrashedPageDocument, TrashListResponse, TrashPageRequest, UpdatePageRequest } from '@nbase/contracts';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { attachmentReferences, validateDocumentContent } from './validate.js';
import { replacePageLinks } from './page-links.js';
import { extractDocumentIndex, type IndexedPageReference } from './search-text.js';

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
      | 'PAGE_TREE_INVALID' | 'PAGE_TREE_CHANGED' | 'CONTENT_VERSION_UNSUPPORTED' | 'ATTACHMENT_INVALID'
      | 'FAVORITE_LIMIT' | 'PAGE_POSITION_INVALID' | 'TAG_INVALID' | 'TAG_NAME_CONFLICT' | 'PAGE_REFERENCE_INVALID'
      | 'PAGE_KIND_INVALID' | 'PROPERTY_INVALID' | 'DATABASE_ROW_LIMIT' | 'DATABASE_SCHEMA_INVALID' | 'DATABASE_UNAVAILABLE',
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
  icon: string | null;
  cover: PageCoverId | null;
  tag_ids?: string[];
  content_json: PageDocument['content'];
  content_schema_version: number;
  kind: PageKind;
  row_properties: RowProperties | null;
  revision: string;
  created_at: Date;
  updated_at: Date;
  cursor_created_at?: string;
}

interface ReceiptRow<T = PageDocument> {
  operation: string;
  request_hash: Buffer;
  page_id: string | null;
  response_status: number;
  response_json: T;
}

interface VersionRow {
  page_id: string; revision: string; title: string; parent_id: string | null;
  icon: string | null; cover: PageCoverId | null; row_properties: RowProperties | null;
  content_json: PageDocument['content']; saved_at: Date; operation: PageVersionOperation;
  deleted_at: Date | null;
}

interface TrashRow extends PageRow {
  deleted_at: Date; deletion_group_id: string; cursor_deleted_at?: string;
}

type BacklinkRow = {
  source_page_id: string; source_title: string; source_revision: string; occurrence: number; snippet: string;
} | {
  source_page_id: null; source_title: null; source_revision: null; occurrence: null; snippet: null;
};

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
    icon: row.icon ?? null,
    cover: row.cover ?? null,
    tagIds: row.tag_ids ?? [],
    kind: row.kind ?? 'document',
    content: row.content_json,
    ...(row.kind === 'row' ? { properties: row.row_properties ?? {} } : {}),
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function summaryFromRow(row: PageRow): PageSummary {
  const { content: _content, properties: _properties, ...summary } = pageFromRow(row);
  void _content; void _properties;
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

/** Their receipts answer with a page, and every such revision has a page_versions snapshot. */
const pageReceiptOperations = new Set(['create', 'update', 'trash', 'restore', 'restore-version', 'copy',
  'open-daily-note', 'quick-capture']);

const sortPositionGap = 1024;

const pageColumns = `id, workspace_id, parent_id, title, icon, cover, content_json, content_schema_version, kind, row_properties,
  revision::text AS revision, created_at, updated_at`;
const joinedPageColumns = `p.id, p.workspace_id, p.parent_id, p.title, p.icon, p.cover, p.content_json, p.content_schema_version,
  p.kind, p.row_properties, p.revision::text AS revision, p.created_at, p.updated_at,
  ARRAY(SELECT pt.tag_id FROM page_tags pt WHERE pt.workspace_id = p.workspace_id AND pt.page_id = p.id ORDER BY pt.tag_id) AS tag_ids`;

export class PgPageRepository {
  constructor(private readonly pool: Pool) {}

  async snapshot(client: PoolClient, workspaceId: string, ids: string[], actorId: string,
    operation: PageVersionOperation): Promise<void> {
    await client.query(`INSERT INTO page_versions (workspace_id, page_id, revision, title, parent_id, icon, cover,
      content_json, content_schema_version, row_properties, deleted_at, saved_at, actor_user_id, operation)
      SELECT workspace_id, id, revision, title, parent_id, icon, cover, content_json, content_schema_version,
        row_properties, deleted_at, updated_at, $3, $4 FROM pages WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
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
      h.title, h.parent_id, h.icon, h.cover, h.row_properties, h.content_json, h.saved_at, h.operation, h.deleted_at FROM page_versions h
      JOIN workspace_memberships m ON m.workspace_id = h.workspace_id AND m.user_id = $2
      WHERE h.workspace_id = $1 AND h.page_id = $3 AND h.revision = $4::bigint`,
    [workspaceId, actorId, pageId, revision]);
    const row = result.rows[0];
    return row ? { ...versionSummary(row), pageId: row.page_id, parentId: row.parent_id,
      icon: row.icon ?? null, cover: row.cover ?? null, content: row.content_json,
      ...(row.row_properties ? { properties: row.row_properties } : {}) } : null;
  }

  async trashList(workspaceId: string, actorId: string, limit: number,
    cursor: { createdAt: string; id: string } | null): Promise<TrashListResponse> {
    const result = await this.pool.query<TrashRow>(`SELECT ${joinedPageColumns}, p.deleted_at,
      p.deletion_group_id, p.deleted_at::text AS cursor_deleted_at FROM pages p
      JOIN workspace_memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2
      WHERE p.workspace_id = $1 AND p.deleted_at IS NOT NULL
        AND NOT (p.kind = 'row' AND p.deletion_group_id <> p.id)
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

  async backlinks(workspaceId: string, actorId: string, pageId: string): Promise<PageBacklinksResponse | null> {
    const result = await this.pool.query<BacklinkRow>(`
      SELECT link.source_page_id, link.source_title, link.source_revision, link.occurrence, link.snippet
      FROM pages target
      JOIN workspace_memberships member ON member.workspace_id = target.workspace_id AND member.user_id = $2
      LEFT JOIN LATERAL (
        SELECT source.id AS source_page_id, source.title AS source_title, source.revision::text AS source_revision,
          source.updated_at AS source_updated_at, refs.occurrence, refs.snippet
        FROM page_links refs
        JOIN pages source ON source.workspace_id = refs.workspace_id AND source.id = refs.source_page_id
          AND source.deleted_at IS NULL
        WHERE refs.workspace_id = target.workspace_id AND refs.target_page_id = target.id
        ORDER BY source.updated_at DESC, source.id, refs.occurrence
        LIMIT $4
      ) link ON true
      WHERE target.workspace_id = $1 AND target.id = $3 AND target.deleted_at IS NULL
      ORDER BY link.source_updated_at DESC, link.source_page_id, link.occurrence
    `, [workspaceId, actorId, pageId, pageBacklinkLimit + 1]);
    if (!result.rows.length) return null;
    const links = result.rows.filter(row => row.source_page_id !== null);
    return { links: links.slice(0, pageBacklinkLimit).map(row => ({
      sourcePageId: row.source_page_id, sourceTitle: row.source_title, sourceRevision: row.source_revision,
      occurrence: row.occurrence, snippet: row.snippet,
    })), truncated: links.length > pageBacklinkLimit };
  }

  async list(workspaceId: string, actorId: string, parentId: string | null,
    limit: number, cursor: { position: string; id: string } | null): Promise<PageListResponse> {
    const result = await this.pool.query<PageRow & { cursor_position: string }>(`
      SELECT ${joinedPageColumns}, p.sort_position::text AS cursor_position FROM pages p
      JOIN workspace_memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2
      WHERE p.workspace_id = $1 AND p.parent_id IS NOT DISTINCT FROM $3::uuid AND p.deleted_at IS NULL
        AND ($4::bigint IS NULL OR (p.sort_position, p.id) > ($4::bigint, $5::uuid))
      ORDER BY p.sort_position, p.id LIMIT $6
    `, [workspaceId, actorId, parentId, cursor?.position ?? null, cursor?.id ?? null, limit + 1]);
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      pages: visible.map(summaryFromRow),
      nextCursor: result.rows.length > limit && last
        ? Buffer.from(JSON.stringify({ position: last.cursor_position, id: last.id })).toString('base64url')
        : null,
    };
  }

  /**
   * Pages reachable from active roots through active parents; membership gates the anchor like `list`.
   * Database rows are listed by the database itself, so the tree stops at database pages.
   */
  async tree(workspaceId: string, actorId: string, limit = 2000): Promise<PageTreeResponse> {
    const result = await this.pool.query<PageRow>(`
      WITH RECURSIVE tree AS (
        SELECT p.id, p.kind FROM pages p
        JOIN workspace_memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2
        WHERE p.workspace_id = $1 AND p.parent_id IS NULL AND p.deleted_at IS NULL
        UNION
        SELECT c.id, c.kind FROM pages c JOIN tree t ON c.parent_id = t.id
        WHERE c.workspace_id = $1 AND c.deleted_at IS NULL AND t.kind <> 'database'
      )
      SELECT ${joinedPageColumns} FROM pages p
      JOIN tree t ON t.id = p.id
      ORDER BY p.sort_position, p.id LIMIT $3
    `, [workspaceId, actorId, limit + 1]);
    return { pages: result.rows.slice(0, limit).map(summaryFromRow), truncated: result.rows.length > limit };
  }

  async receipt(workspaceId: string, actorId: string, mutationId: string): Promise<MutationResult<PageDocument> | null> {
    const result = await this.pool.query<ReceiptRow>(`
      SELECT r.operation, r.request_hash, r.page_id, r.response_status, r.response_json
      FROM page_mutation_receipts r
      JOIN workspace_memberships m ON m.workspace_id = r.workspace_id AND m.user_id = $2
      WHERE r.workspace_id = $1 AND r.actor_user_id = $2 AND r.client_mutation_id = $3
        AND r.page_id IS NOT NULL
    `, [workspaceId, actorId, mutationId]);
    const row = result.rows[0];
    return row ? { statusCode: row.response_status, body: await this.expandReceipt(this.pool, workspaceId, row) } : null;
  }

  /** Keep one copy of the body: drop it only when the revision snapshot holds exactly the same JSON. */
  private async compactReceipt(client: PoolClient, workspaceId: string, operation: string,
    pageId: string | null, body: object): Promise<object> {
    if (pageId === null || !pageReceiptOperations.has(operation) || !('content' in body) || !('revision' in body)) return body;
    const { content, ...compact } = body;
    const same = await client.query(`SELECT 1 FROM page_versions
      WHERE workspace_id = $1 AND page_id = $2 AND revision = $3::bigint AND content_json = $4::jsonb`,
    [workspaceId, pageId, body.revision, JSON.stringify(content)]);
    return same.rows[0] ? compact : body;
  }

  /** A replay must return the body of that revision, not the page's current one. */
  private async expandReceipt<T>(db: Pick<Pool, 'query'>, workspaceId: string, row: ReceiptRow<T>): Promise<T> {
    const body = row.response_json as T & { revision?: string };
    if (row.page_id === null || !pageReceiptOperations.has(row.operation) || 'content' in (body as object)) return body;
    const version = await db.query<{ content_json: PageDocument['content'] }>(`SELECT content_json FROM page_versions
      WHERE workspace_id = $1 AND page_id = $2 AND revision = $3::bigint`, [workspaceId, row.page_id, body.revision]);
    if (!version.rows[0]) throw new Error('Receipt snapshot is missing');
    return { ...body, content: version.rows[0].content_json };
  }

  async search(workspaceId: string, actorId: string, phrase: string, limit: number, tagIds: string[] = []): Promise<SearchResponse> {
    const result = await this.pool.query<{ id: string; parent_id: string | null; title: string; icon: string | null;
      revision: string; updated_at: Date; search_text: string; title_match: boolean }>(`
      SELECT p.id, p.parent_id, p.title, p.icon, p.revision::text AS revision, p.updated_at, p.search_text,
        (position(lower($3) in lower(p.title)) > 0) AS title_match
      FROM pages p
      JOIN workspace_memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2
      WHERE p.workspace_id = $1 AND p.deleted_at IS NULL
        AND (position(lower($3) in lower(p.title)) > 0
          OR position(lower($3) in lower(p.search_text)) > 0)
        AND NOT EXISTS (
          SELECT 1 FROM unnest($5::uuid[]) AS required(tag_id)
          WHERE NOT EXISTS (SELECT 1 FROM page_tags pt
            WHERE pt.workspace_id = p.workspace_id AND pt.page_id = p.id AND pt.tag_id = required.tag_id)
        )
      ORDER BY title_match DESC, p.updated_at DESC, p.id
      LIMIT $4
    `, [workspaceId, actorId, phrase, limit + 1, tagIds]);
    return { results: result.rows.slice(0, limit).map(row => ({ pageId: row.id, title: row.title, icon: row.icon ?? null,
      parentId: row.parent_id, revision: row.revision, updatedAt: row.updated_at.toISOString(),
      snippet: searchSnippet(row.search_text, phrase), matchField: row.title_match ? 'title' as const : 'content' as const })),
    truncated: result.rows.length > limit };
  }

  /** Run one authorized write and its idempotency receipt under the workspace lock. */
  async mutate<T extends object>(
    workspaceId: string, actorId: string, mutationId: string, operation: string,
    pageId: string | null, body: unknown,
    action: (client: PoolClient, role: 'owner' | 'editor') => Promise<MutationResult<T>>,
    receiptPageId: (response: T) => string | null = response =>
      'id' in response && typeof response.id === 'string' ? response.id : null,
  ): Promise<MutationResult<T>> {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      // Serializes every tree mutation and same-key retry in this workspace.
      const membership = await client.query<{ role: 'owner' | 'editor' | 'viewer' }>(`
        SELECT m.role FROM workspaces w
        JOIN workspace_memberships m ON m.workspace_id = w.id AND m.user_id = $2
        WHERE w.id = $1 FOR UPDATE OF w
      `, [workspaceId, actorId]);
      if (!membership.rows[0]) throw new PageError(404, 'NOT_FOUND');
      if (membership.rows[0].role === 'viewer') throw new PageError(403, 'FORBIDDEN');

      const hash = requestHash(operation, pageId, body);
      const prior = await client.query<ReceiptRow<T>>(`
        SELECT operation, request_hash, page_id, response_status, response_json FROM page_mutation_receipts
        WHERE workspace_id = $1 AND actor_user_id = $2 AND client_mutation_id = $3
      `, [workspaceId, actorId, mutationId]);
      const receipt = prior.rows[0];
      if (receipt) {
        if (receipt.operation !== operation || !receipt.request_hash.equals(hash)) {
          throw new PageError(409, 'MUTATION_CONFLICT');
        }
        const replayed = await this.expandReceipt(client, workspaceId, receipt);
        await client.query('COMMIT');
        transactionOpen = false;
        return { statusCode: receipt.response_status, body: replayed };
      }

      const result = await action(client, membership.rows[0].role);
      const receiptPage = receiptPageId(result.body);
      const stored = await this.compactReceipt(client, workspaceId, operation, receiptPage, result.body);
      await client.query(`
        INSERT INTO page_mutation_receipts
          (workspace_id, actor_user_id, client_mutation_id, operation, request_hash, page_id, response_status, response_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `, [workspaceId, actorId, mutationId, operation, hash, receiptPage, result.statusCode, JSON.stringify(stored)]);
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

  private async validatePageReferenceTargets(client: PoolClient, workspaceId: string,
    references: IndexedPageReference[]): Promise<void> {
    if (!references.length) return;
    const ids = [...new Set(references.map(reference => reference.targetPageId))];
    // Trashed targets keep their identity so saved references can resolve after restoration.
    const result = await client.query('SELECT id FROM pages WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
      [workspaceId, ids]);
    if (result.rows.length !== ids.length) throw new PageError(422, 'PAGE_REFERENCE_INVALID');
  }

  async create(workspaceId: string, actorId: string, body: CreatePageRequest): Promise<MutationResult<PageDocument>> {
    return this.mutate(workspaceId, actorId, body.clientMutationId, 'create', null, body,
      client => this.createInTransaction(client, workspaceId, actorId, body));
  }

  private async replaceTags(client: PoolClient, workspaceId: string, pageId: string, tagIds: string[]): Promise<string[]> {
    const next = tagIds.map(id => id.toLowerCase()).sort();
    if (next.length) {
      const allowed = await client.query('SELECT id FROM workspace_tags WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
        [workspaceId, next]);
      if (allowed.rows.length !== next.length) throw new PageError(422, 'TAG_INVALID');
    }
    await client.query('DELETE FROM page_tags WHERE workspace_id = $1 AND page_id = $2 AND tag_id <> ALL($3::uuid[])',
      [workspaceId, pageId, next]);
    if (next.length) await client.query(`INSERT INTO page_tags (workspace_id, page_id, tag_id)
      SELECT $1, $2, tag_id FROM unnest($3::uuid[]) AS tags(tag_id) ON CONFLICT DO NOTHING`, [workspaceId, pageId, next]);
    return next;
  }

  async getInTransaction(client: PoolClient, workspaceId: string, pageId: string): Promise<PageDocument> {
    const result = await client.query<PageRow>(`
      SELECT ${joinedPageColumns} FROM pages p WHERE p.workspace_id = $1 AND p.id = $2 AND p.deleted_at IS NULL FOR UPDATE OF p
    `, [workspaceId, pageId]);
    const row = result.rows[0];
    if (!row) throw new PageError(404, 'NOT_FOUND');
    if (row.content_schema_version !== 1) throw new PageError(422, 'CONTENT_VERSION_UNSUPPORTED');
    return pageFromRow(row);
  }

  /**
   * A page created under a database becomes one of its rows; `database` is only requested by the
   * database module. Rows cannot have children, and databases cannot nest inside databases.
   */
  async createInTransaction(client: PoolClient, workspaceId: string, actorId: string,
    body: CreatePageRequest, requestedKind: 'document' | 'database' = 'document'): Promise<MutationResult<PageDocument>> {
    await this.validateAttachments(client, workspaceId, body.content);
    const index = extractDocumentIndex(body.content);
    await this.validatePageReferenceTargets(client, workspaceId, index.references);
    let kind: PageKind = requestedKind;
    let rowProperties: RowProperties | null = null;
    let searchText = index.searchText;
    if (body.parentId !== null) {
      const parent = await client.query<{ kind: PageKind }>(
        'SELECT kind FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL',
        [workspaceId, body.parentId],
      );
      const parentKind = parent.rows[0]?.kind;
      if (!parentKind) throw new PageError(422, 'PAGE_TREE_INVALID');
      if (parentKind === 'row' || (parentKind === 'database' && requestedKind === 'database')) {
        throw new PageError(422, 'PAGE_KIND_INVALID');
      }
      if (parentKind === 'database') {
        kind = 'row';
        const schema = await loadDatabaseSchema(client, workspaceId, body.parentId);
        if (!schema) throw new PageError(422, 'DATABASE_UNAVAILABLE');
        const count = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pages
          WHERE workspace_id = $1 AND parent_id = $2 AND deleted_at IS NULL`, [workspaceId, body.parentId]);
        if ((count.rows[0]?.n ?? 0) >= databaseRowLimit) throw new PageError(409, 'DATABASE_ROW_LIMIT');
        rowProperties = this.mergeProperties(schema.properties_json, {}, body.properties ?? {});
        searchText = rowIndexText(index.searchText, schema.properties_json, rowProperties);
      }
    }
    if (body.properties !== undefined && kind !== 'row') throw new PageError(422, 'PAGE_KIND_INVALID');
    const result = await client.query<PageRow>(`
      INSERT INTO pages (id, workspace_id, parent_id, title, icon, cover, content_json, content_schema_version, search_text,
        kind, row_properties)
      VALUES ($1, $2, $3, $4, $7, $8, $5::jsonb, 1, $6, $9, $10::jsonb)
      RETURNING ${pageColumns}
    `, [randomUUID(), workspaceId, body.parentId, body.title, JSON.stringify(body.content),
      searchText, body.icon ?? null, body.cover ?? null, kind, rowProperties ? JSON.stringify(rowProperties) : null]);
    const page = pageFromRow(result.rows[0]!);
    if (body.tagIds?.length) page.tagIds = await this.replaceTags(client, workspaceId, page.id, body.tagIds);
    if (index.references.length) await replacePageLinks(client, workspaceId, page.id, index.references);
    await this.snapshot(client, workspaceId, [page.id], actorId, 'create');
    if (kind === 'row' && body.parentId) await this.rowChanged(client, workspaceId, body.parentId, [page.id]);
    return { statusCode: 201, body: page };
  }

  private mergeProperties(...args: Parameters<typeof mergeRowProperties>): RowProperties {
    try {
      return mergeRowProperties(...args);
    } catch {
      throw new PageError(422, 'PROPERTY_INVALID');
    }
  }

  private async validateParent(client: PoolClient, workspaceId: string, pageId: string, parentId: string): Promise<void> {
    const target = await client.query<{ kind: PageKind }>(
      'SELECT kind FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL', [workspaceId, parentId]);
    // Moving pages into a database or under a row is not supported; rows are created in place.
    if (target.rows[0] && target.rows[0].kind !== 'document') throw new PageError(422, 'PAGE_KIND_INVALID');
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
    return this.mutate(workspaceId, actorId, body.clientMutationId, 'update', pageId, body,
      client => this.updateInTransaction(client, workspaceId, actorId, pageId, body));
  }

  async updateInTransaction(client: PoolClient, workspaceId: string, actorId: string,
    pageId: string, body: UpdatePageRequest): Promise<MutationResult<PageDocument>> {
    const existing = await client.query<PageRow>(`
      SELECT ${joinedPageColumns} FROM pages p WHERE p.workspace_id = $1 AND p.id = $2 AND p.deleted_at IS NULL FOR UPDATE OF p
    `, [workspaceId, pageId]);
    const row = existing.rows[0];
    if (!row) throw new PageError(404, 'NOT_FOUND');
    if (row.content_schema_version !== 1) throw new PageError(422, 'CONTENT_VERSION_UNSUPPORTED');
    if (row.revision !== body.expectedRevision) throw new PageError(409, 'REVISION_CONFLICT', row.revision);
    if (row.kind === 'database' && body.content) throw new PageError(422, 'PAGE_KIND_INVALID');
    if (body.properties !== undefined && row.kind !== 'row') throw new PageError(422, 'PAGE_KIND_INVALID');
    if (row.kind === 'row' && body.parentId !== undefined && body.parentId !== row.parent_id) {
      throw new PageError(422, 'PAGE_KIND_INVALID');
    }
    if (body.content) await this.validateAttachments(client, workspaceId, body.content);
    const index = body.content ? extractDocumentIndex(body.content) : null;
    if (index) await this.validatePageReferenceTargets(client, workspaceId, index.references);
    const parentId = body.parentId === undefined ? row.parent_id : body.parentId;
    if (parentId !== null && parentId !== row.parent_id) await this.validateParent(client, workspaceId, pageId, parentId);
    const icon = body.icon === undefined ? row.icon : body.icon;
    const cover = body.cover === undefined ? row.cover : body.cover;
    let rowProperties = row.row_properties;
    let searchText = index?.searchText ?? null;
    if (row.kind === 'row' && (index || body.properties)) {
      const schema = row.parent_id ? await loadDatabaseSchema(client, workspaceId, row.parent_id) : null;
      if (!schema) throw new PageError(422, 'DATABASE_UNAVAILABLE');
      if (body.properties) rowProperties = this.mergeProperties(schema.properties_json, row.row_properties ?? {}, body.properties);
      const bodyText = index?.searchText ?? extractDocumentIndex(row.content_json).searchText;
      searchText = rowIndexText(bodyText, schema.properties_json, rowProperties ?? {});
    }

    const result = await client.query<PageRow>(`
      UPDATE pages SET title = $3, parent_id = $4, content_json = $5::jsonb,
        content_schema_version = 1, search_text = COALESCE($7, search_text), icon = $8, cover = $9,
        row_properties = $10::jsonb,
        sort_position = CASE WHEN parent_id IS DISTINCT FROM $4::uuid THEN nextval('pages_sort_position_seq') * 1024 ELSE sort_position END,
        revision = revision + 1, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND revision = $6::bigint AND deleted_at IS NULL
      RETURNING ${pageColumns}
    `, [workspaceId, pageId, body.title ?? row.title, parentId,
      JSON.stringify(body.content ?? row.content_json), body.expectedRevision,
      searchText, icon, cover, rowProperties ? JSON.stringify(rowProperties) : null]);
    if (!result.rows[0]) throw new PageError(409, 'REVISION_CONFLICT');
    const tagIds = body.tagIds === undefined ? row.tag_ids : await this.replaceTags(client, workspaceId, pageId, body.tagIds);
    if (index) await replacePageLinks(client, workspaceId, pageId, index.references);
    await this.snapshot(client, workspaceId, [pageId], actorId, 'update');
    if (row.kind === 'row' && row.parent_id && (body.properties || body.title !== undefined)) await this.rowChanged(client, workspaceId, row.parent_id, [pageId]);
    return { statusCode: 200, body: pageFromRow({ ...result.rows[0], tag_ids: tagIds ?? [] }) };
  }

  private async rowChanged(client: PoolClient, workspaceId: string, databaseId: string, rowIds: string[]): Promise<void> {
    const schema = await loadDatabaseSchema(client, workspaceId, databaseId);
    if (schema) await markRowsChanged(client, workspaceId, databaseId, schema.properties_json, rowIds);
  }

  async trash(workspaceId: string, actorId: string, pageId: string,
    body: TrashPageRequest): Promise<MutationResult<PageDocument>> {
    return this.mutate(workspaceId, actorId, body.clientMutationId, 'trash', pageId, body, async (client) => {
      const existing = await client.query<PageRow>(`
        SELECT ${joinedPageColumns} FROM pages p WHERE p.workspace_id = $1 AND p.id = $2 AND p.deleted_at IS NULL FOR UPDATE OF p
      `, [workspaceId, pageId]);
      const row = existing.rows[0];
      if (!row) throw new PageError(404, 'NOT_FOUND');
      if (row.revision !== body.expectedRevision) throw new PageError(409, 'REVISION_CONFLICT', row.revision);
      if (body.expectedSubtreeIds) {
        // Clients see the page tree, which lists databases but not their rows; rows go along with them.
        const actual = await client.query<{ id: string }>(`WITH RECURSIVE subtree AS (
          SELECT id FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
          UNION ALL SELECT child.id FROM pages child JOIN subtree parent ON child.parent_id = parent.id
          WHERE child.workspace_id = $1 AND child.deleted_at IS NULL AND child.kind <> 'row'
        ) SELECT id FROM subtree`, [workspaceId, pageId]);
        const expected = body.expectedSubtreeIds.map(id => id.toLowerCase()).sort();
        if (JSON.stringify(actual.rows.map(item => item.id).sort()) !== JSON.stringify(expected)) {
          throw new PageError(409, 'PAGE_TREE_CHANGED');
        }
      }
      // Rows leaving with their database keep revision and body untouched, so they need no snapshot of their own.
      const deleted = await client.query<{ id: string; kind: string }>(`
        WITH RECURSIVE subtree AS (
          SELECT id FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
          UNION ALL
          SELECT child.id FROM pages child JOIN subtree parent ON child.parent_id = parent.id
          WHERE child.workspace_id = $1 AND child.deleted_at IS NULL
        )
        UPDATE pages p SET deleted_at = now(), deletion_group_id = $2,
          revision = CASE WHEN p.kind = 'row' AND p.id <> $2 THEN p.revision ELSE p.revision + 1 END,
          updated_at = CASE WHEN p.kind = 'row' AND p.id <> $2 THEN p.updated_at ELSE now() END
        WHERE p.workspace_id = $1 AND p.id IN (SELECT id FROM subtree)
        RETURNING p.id, p.kind
      `, [workspaceId, pageId]);
      const root = await client.query<PageRow>(`SELECT ${pageColumns} FROM pages WHERE workspace_id = $1 AND id = $2`, [workspaceId, pageId]);
      if (!root.rows[0]) throw new PageError(404, 'NOT_FOUND');
      await this.snapshot(client, workspaceId, deleted.rows.filter(item => item.kind !== 'row' || item.id === pageId).map(item => item.id),
        actorId, 'trash');
      if (root.rows[0].kind === 'row' && root.rows[0].parent_id) await this.rowChanged(client, workspaceId, root.rows[0].parent_id, [pageId]);
      return { statusCode: 200, body: pageFromRow({ ...root.rows[0], tag_ids: row.tag_ids ?? [] }) };
    });
  }

  async restore(workspaceId: string, actorId: string, pageId: string,
    body: PageStateRequest): Promise<MutationResult<PageDocument>> {
    return this.mutate(workspaceId, actorId, body.clientMutationId, 'restore', pageId, body, async (client) => {
      const existing = await client.query<PageRow & { deletion_group_id: string }>(`
        SELECT ${joinedPageColumns}, p.deletion_group_id FROM pages p
        WHERE p.workspace_id = $1 AND p.id = $2 AND p.deleted_at IS NOT NULL FOR UPDATE OF p
      `, [workspaceId, pageId]);
      const row = existing.rows[0];
      if (!row) throw new PageError(404, 'NOT_FOUND');
      if (row.revision !== body.expectedRevision) throw new PageError(409, 'REVISION_CONFLICT', row.revision);
      let parentId = row.parent_id;
      if (row.parent_id) {
        const parent = await client.query('SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL',
          [workspaceId, row.parent_id]);
        if (!parent.rows[0]) {
          // A row cannot stand alone; its database has to come back first.
          if (row.kind === 'row') throw new PageError(409, 'DATABASE_UNAVAILABLE');
          parentId = null;
        }
      }
      const restored = await client.query<{ id: string; kind: string }>(`
        WITH RECURSIVE subtree AS (
          SELECT id FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NOT NULL
          UNION ALL
          SELECT child.id FROM pages child JOIN subtree parent ON child.parent_id = parent.id
          WHERE child.workspace_id = $1 AND child.deleted_at IS NOT NULL AND child.deletion_group_id = $3
        )
        UPDATE pages SET deleted_at = NULL, deletion_group_id = NULL,
          parent_id = CASE WHEN id = $2 THEN $4::uuid ELSE parent_id END,
          sort_position = CASE WHEN id = $2 AND parent_id IS DISTINCT FROM $4::uuid
            THEN nextval('pages_sort_position_seq') * 1024 ELSE sort_position END,
          revision = CASE WHEN kind = 'row' AND id <> $2 THEN revision ELSE revision + 1 END,
          updated_at = CASE WHEN kind = 'row' AND id <> $2 THEN updated_at ELSE now() END
        WHERE workspace_id = $1 AND id IN (SELECT id FROM subtree)
        RETURNING id, kind
      `, [workspaceId, pageId, row.deletion_group_id, parentId]);
      const root = await client.query<PageRow>(`SELECT ${pageColumns} FROM pages WHERE workspace_id = $1 AND id = $2`, [workspaceId, pageId]);
      if (!root.rows[0]) throw new PageError(404, 'NOT_FOUND');
      await this.snapshot(client, workspaceId, restored.rows.filter(item => item.kind !== 'row' || item.id === pageId).map(item => item.id),
        actorId, 'restore');
      if (root.rows[0].kind === 'row' && root.rows[0].parent_id) await this.rowChanged(client, workspaceId, root.rows[0].parent_id, [pageId]);
      return { statusCode: 200, body: pageFromRow({ ...root.rows[0], tag_ids: row.tag_ids ?? [] }) };
    });
  }

  async restoreVersion(workspaceId: string, actorId: string, pageId: string,
    body: RestorePageVersionRequest): Promise<MutationResult<PageDocument>> {
    return this.mutate(workspaceId, actorId, body.clientMutationId, 'restore-version', pageId, body, async client => {
      const existing = await client.query<PageRow>(`SELECT ${joinedPageColumns} FROM pages p
        WHERE p.workspace_id = $1 AND p.id = $2 AND p.deleted_at IS NULL FOR UPDATE OF p`, [workspaceId, pageId]);
      const current = existing.rows[0];
      if (!current) throw new PageError(404, 'NOT_FOUND');
      if (current.content_schema_version !== 1) throw new PageError(422, 'CONTENT_VERSION_UNSUPPORTED');
      if (current.revision !== body.expectedRevision) throw new PageError(409, 'REVISION_CONFLICT', current.revision);
      if (current.kind === 'database') throw new PageError(422, 'PAGE_KIND_INVALID');
      const source = await client.query<{ title: string; content_json: PageDocument['content'];
        row_properties: RowProperties | null }>(
        'SELECT title, content_json, row_properties FROM page_versions WHERE workspace_id = $1 AND page_id = $2 AND revision = $3::bigint',
        [workspaceId, pageId, body.sourceRevision]);
      const version = source.rows[0];
      if (!version) throw new PageError(404, 'NOT_FOUND');
      const content = validateDocumentContent(version.content_json);
      await this.validateAttachments(client, workspaceId, content);
      const index = extractDocumentIndex(content);
      await this.validatePageReferenceTargets(client, workspaceId, index.references);
      let searchText = index.searchText;
      let rowProperties = current.row_properties;
      if (current.kind === 'row') {
        // Values are restored as stored; ones the current schema no longer reads simply display as empty.
        const schema = current.parent_id ? await loadDatabaseSchema(client, workspaceId, current.parent_id) : null;
        if (!schema) throw new PageError(422, 'DATABASE_UNAVAILABLE');
        rowProperties = version.row_properties ?? current.row_properties ?? {};
        searchText = rowIndexText(index.searchText, schema.properties_json, rowProperties);
      }
      // Restore title/body (and row values) and retain the current page metadata.
      const result = await client.query<PageRow>(`UPDATE pages SET title = $3, content_json = $4::jsonb,
        content_schema_version = 1, search_text = $5, row_properties = $6::jsonb, revision = revision + 1, updated_at = now()
        WHERE workspace_id = $1 AND id = $2 RETURNING ${pageColumns}`,
      [workspaceId, pageId, version.title, JSON.stringify(content), searchText,
        rowProperties ? JSON.stringify(rowProperties) : null]);
      await replacePageLinks(client, workspaceId, pageId, index.references);
      if (current.kind === 'row' && current.parent_id) {
        const schema = await loadDatabaseSchema(client, workspaceId, current.parent_id);
        if (schema) {
          await syncRelationLinks(client, workspaceId, schema.properties_json, [{ id: pageId, values: rowProperties ?? {} }]);
          await markRowsChanged(client, workspaceId, current.parent_id, schema.properties_json, [pageId]);
        }
      }
      await this.snapshot(client, workspaceId, [pageId], actorId, 'restore-version');
      return { statusCode: 200, body: pageFromRow({ ...result.rows[0]!, tag_ids: current.tag_ids ?? [] }) };
    });
  }

  /* ================= favorites =================
     Personal preference data: idempotent writes, no mutation receipts,
     no revision bump and no page_versions rows. */

  private async workspaceLock<T>(workspaceId: string, actorId: string,
    action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const membership = await client.query<{ role: string }>(`
        SELECT m.role FROM workspaces w
        JOIN workspace_memberships m ON m.workspace_id = w.id AND m.user_id = $2
        WHERE w.id = $1 FOR UPDATE OF w
      `, [workspaceId, actorId]);
      if (!membership.rows[0]) throw new PageError(404, 'NOT_FOUND');
      if (membership.rows[0].role === 'viewer') throw new PageError(403, 'FORBIDDEN');
      const result = await action(client);
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

  async favorites(workspaceId: string, actorId: string): Promise<FavoriteListResponse> {
    const result = await this.pool.query<{ page_id: string }>(`
      SELECT f.page_id FROM page_favorites f
      JOIN workspace_memberships m ON m.workspace_id = f.workspace_id AND m.user_id = $2 AND m.user_id = f.user_id
      JOIN pages p ON p.workspace_id = f.workspace_id AND p.id = f.page_id AND p.deleted_at IS NULL
      WHERE f.workspace_id = $1 AND f.user_id = $2
      ORDER BY f.created_at, f.page_id
    `, [workspaceId, actorId]);
    return { pageIds: result.rows.map(row => row.page_id) };
  }

  async favoriteAdd(workspaceId: string, actorId: string, pageId: string): Promise<void> {
    await this.workspaceLock(workspaceId, actorId, async (client) => {
      const page = await client.query(
        'SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL', [workspaceId, pageId]);
      if (!page.rows[0]) throw new PageError(404, 'NOT_FOUND');
      const count = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM page_favorites WHERE workspace_id = $1 AND user_id = $2', [workspaceId, actorId]);
      if ((count.rows[0]?.n ?? 0) >= 200) throw new PageError(409, 'FAVORITE_LIMIT');
      await client.query(
        'INSERT INTO page_favorites (workspace_id, user_id, page_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [workspaceId, actorId, pageId]);
    });
  }

  /**
   * Places a page right after a sibling, or first when `afterPageId` is null. The target
   * position is absolute, so a retry after a lost response cannot move the page twice.
   * Order is directory structure, not page content, so no revision or snapshot is written.
   */
  async setPosition(workspaceId: string, actorId: string, pageId: string, afterPageId: string | null): Promise<void> {
    await this.workspaceLock(workspaceId, actorId, async (client) => {
      const page = await client.query<{ parent_id: string | null }>(
        'SELECT parent_id FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL', [workspaceId, pageId]);
      const row = page.rows[0];
      if (!row) throw new PageError(404, 'NOT_FOUND');
      // Sibling groups can hold tens of thousands of rows, so only the neighbours are read.
      type Sibling = { id: string; sort_position: string };
      const siblingFilter = `workspace_id = $1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND deleted_at IS NULL AND id <> $3`;
      let anchor: Sibling | undefined;
      if (afterPageId !== null) {
        const found = await client.query<Sibling>(`SELECT id, sort_position::text AS sort_position FROM pages
          WHERE ${siblingFilter} AND id = $4`, [workspaceId, row.parent_id, pageId, afterPageId]);
        anchor = found.rows[0];
        if (!anchor) throw new PageError(409, 'PAGE_POSITION_INVALID');
      }
      const toward = (direction: 'before' | 'after', limit: number) => client.query<Sibling>(`
        SELECT id, sort_position::text AS sort_position FROM pages WHERE ${siblingFilter}
          AND ($4::bigint IS NULL OR (sort_position, id) ${direction === 'after' ? '>' : '<='} ($4::bigint, $5::uuid))
        ORDER BY pages.sort_position ${direction === 'after' ? 'ASC' : 'DESC'}, id ${direction === 'after' ? 'ASC' : 'DESC'} LIMIT $6
      `, [workspaceId, row.parent_id, pageId, anchor?.sort_position ?? null, anchor?.id ?? null, limit]).then(result => result.rows);
      const next = (await toward('after', 1))[0];
      if (!anchor && !next) return;
      const step = BigInt(sortPositionGap);
      const lower = anchor ? BigInt(anchor.sort_position) : BigInt(next!.sort_position) - 2n * step;
      const upper = next ? BigInt(next.sort_position) : lower + 2n * step;
      if (upper - lower >= 2n) {
        await client.query('UPDATE pages SET sort_position = $3::bigint WHERE workspace_id = $1 AND id = $2',
          [workspaceId, pageId, String((lower + upper) / 2n)]);
        return;
      }
      // The gap is used up: spread out a run around the spot, widening it only until there is room.
      for (let size = 64; ; size *= 4) {
        const low = anchor ? await toward('before', size + 1) : [];
        const high = await toward('after', size + 1);
        const lowOpen = low.length <= size;
        const highOpen = high.length <= size;
        const ids = [...low.slice(0, size).reverse().map(item => item.id), pageId, ...high.slice(0, size).map(item => item.id)];
        const room = BigInt(ids.length + 1) * step;
        const floor = lowOpen ? BigInt((low.at(-1) ?? high[0]!).sort_position) - room : BigInt(low[size]!.sort_position);
        const ceiling = highOpen ? BigInt((high.at(-1) ?? low[0]!).sort_position) + room : BigInt(high[size]!.sort_position);
        const spacing = (ceiling - floor) / BigInt(ids.length + 1);
        if (spacing < 64n && !(lowOpen && highOpen)) continue;
        await client.query(`
          UPDATE pages p SET sort_position = $3::bigint + v.position * $4::bigint
          FROM unnest($2::uuid[]) WITH ORDINALITY AS v(id, position)
          WHERE p.workspace_id = $1 AND p.id = v.id
        `, [workspaceId, ids, String(floor), String(spacing)]);
        return;
      }
    });
  }

  async favoriteRemove(workspaceId: string, actorId: string, pageId: string): Promise<void> {
    await this.workspaceLock(workspaceId, actorId, async (client) => {
      await client.query(
        'DELETE FROM page_favorites WHERE workspace_id = $1 AND user_id = $2 AND page_id = $3',
        [workspaceId, actorId, pageId]);
    });
  }
}

/** Cursor for sibling lists, which follow the manual page order. */
export function decodeSiblingCursor(value: string): { position: string; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return null;
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const data = parsed as Record<string, unknown>;
    if (typeof data.position !== 'string' || !/^-?\d{1,19}$/.test(data.position) || !isUuid(data.id)) return null;
    return { position: data.position, id: data.id };
  } catch {
    return null;
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
