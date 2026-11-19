import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { PageShare, SharedPageResponse, SharedPageSummary, ShareLifetimeDays, ShareStatus } from '@nbase/contracts';
import { activeSharesPerPageLimit } from '@nbase/contracts';
import type { Pool, PoolClient } from 'pg';
import { WorkspaceRouteError } from '../auth/workspace.js';
import { newInvitationToken } from '../members/repository.js';
import { attachmentReferences } from '../pages/validate.js';

/** Pages a share can list; databases and their rows stay out, and so does everything below them. */
const sharedKinds = ['document', 'whiteboard'];
const scopeLimit = 2000;

interface ShareRow {
  id: string; workspace_id: string; page_id: string; token_hash: Buffer; include_children: boolean;
  created_by: string; created_login: string; created_at: Date; expires_at: Date; revoked_at: Date | null;
  view_count: number; last_viewed_at: Date | null; expired: boolean;
}

export interface ShareAccess { id: string; workspaceId: string; pageId: string; includeChildren: boolean; expiresAt: Date }

const shareColumns = `s.id, s.workspace_id, s.page_id, s.token_hash, s.include_children, s.created_by, u.login_name AS created_login,
  s.created_at, s.expires_at, s.revoked_at, s.view_count, s.last_viewed_at, s.expires_at <= now() AS expired`;

function status(row: ShareRow): ShareStatus {
  if (row.revoked_at) return 'revoked';
  return row.expired ? 'expired' : 'active';
}

function shareFromRow(row: ShareRow): PageShare {
  return { id: row.id, pageId: row.page_id, includeChildren: row.include_children, status: status(row),
    createdBy: { userId: row.created_by, loginName: row.created_login }, createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null, viewCount: row.view_count,
    lastViewedAt: row.last_viewed_at?.toISOString() ?? null };
}

/** The share's pages: the root, then (with children) every live descendant reached through shareable pages. */
const scopeSql = `WITH RECURSIVE scope AS (
    SELECT p.id, p.parent_id, p.title, p.kind, p.sort_position, 0 AS depth FROM pages p
    WHERE p.workspace_id = $1 AND p.id = $2 AND p.deleted_at IS NULL AND p.kind = 'document'
    UNION ALL
    SELECT c.id, c.parent_id, c.title, c.kind, c.sort_position, s.depth + 1 FROM pages c JOIN scope s ON c.parent_id = s.id
    WHERE $3 AND c.workspace_id = $1 AND c.deleted_at IS NULL AND c.kind = ANY($4::text[]) AND s.depth < 64
  )`;

export class PgShareRepository {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query('BEGIN');
      open = true;
      const result = await action(client);
      await client.query('COMMIT');
      open = false;
      return result;
    } catch (error) {
      if (open) { try { await client.query('ROLLBACK'); } catch { /* Keep the original error. */ } }
      throw error;
    } finally { client.release(); }
  }

  private async row(db: Pick<Pool, 'query'>, workspaceId: string, shareId: string): Promise<ShareRow | null> {
    const result = await db.query<ShareRow>(`SELECT ${shareColumns} FROM page_share_links s JOIN users u ON u.id = s.created_by
      WHERE s.workspace_id = $1 AND s.id = $2`, [workspaceId, shareId]);
    return result.rows[0] ?? null;
  }

  async list(workspaceId: string, pageId: string): Promise<PageShare[]> {
    const page = await this.pool.query('SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL',
      [workspaceId, pageId]);
    if (!page.rows[0]) throw new WorkspaceRouteError(404, 'NOT_FOUND');
    const result = await this.pool.query<ShareRow>(`SELECT ${shareColumns} FROM page_share_links s JOIN users u ON u.id = s.created_by
      WHERE s.workspace_id = $1 AND s.page_id = $2 ORDER BY s.created_at DESC, s.id LIMIT 200`, [workspaceId, pageId]);
    return result.rows.map(shareFromRow);
  }

  async create(workspaceId: string, actorId: string, pageId: string, includeChildren: boolean,
    days: ShareLifetimeDays): Promise<{ share: PageShare; token: string }> {
    return this.transaction(async client => {
      const page = await client.query<{ kind: string }>(`SELECT kind FROM pages
        WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL FOR NO KEY UPDATE`, [workspaceId, pageId]);
      if (!page.rows[0]) throw new WorkspaceRouteError(404, 'NOT_FOUND');
      if (page.rows[0].kind !== 'document') throw new WorkspaceRouteError(422, 'PAGE_KIND_INVALID');
      const active = await client.query<{ count: string }>(`SELECT count(*) FROM page_share_links
        WHERE workspace_id = $1 AND page_id = $2 AND revoked_at IS NULL AND expires_at > now()`, [workspaceId, pageId]);
      if (Number(active.rows[0]!.count) >= activeSharesPerPageLimit) throw new WorkspaceRouteError(422, 'SHARE_LIMIT');
      const { token, tokenHash } = newInvitationToken();
      const id = randomUUID();
      await client.query(`INSERT INTO page_share_links (id, workspace_id, page_id, token_hash, include_children, created_by, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))`,
      [id, workspaceId, pageId, tokenHash, includeChildren, actorId, days]);
      return { share: shareFromRow((await this.row(client, workspaceId, id))!), token };
    });
  }

  /** Revoking twice is not an error. */
  async revoke(workspaceId: string, shareId: string): Promise<PageShare> {
    await this.pool.query('UPDATE page_share_links SET revoked_at = now() WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL',
      [workspaceId, shareId]);
    const row = await this.row(this.pool, workspaceId, shareId);
    if (!row) throw new WorkspaceRouteError(404, 'NOT_FOUND');
    return shareFromRow(row);
  }

  /** `null` when the token does not match; 'ended' when it matches a revoked or expired link, or a root page in the trash. */
  async open(shareId: string, tokenHash: Buffer): Promise<ShareAccess | 'ended' | null> {
    const result = await this.pool.query<ShareRow & { root_live: boolean }>(`SELECT s.id, s.workspace_id, s.page_id, s.token_hash,
      s.include_children, s.expires_at, s.revoked_at, s.expires_at <= now() AS expired,
      EXISTS (SELECT 1 FROM pages p WHERE p.workspace_id = s.workspace_id AND p.id = s.page_id AND p.deleted_at IS NULL) AS root_live
      FROM page_share_links s WHERE s.id = $1`, [shareId]);
    const row = result.rows[0];
    if (!row || !timingSafeEqual(row.token_hash, tokenHash)) return null;
    if (row.revoked_at || row.expired || !row.root_live) return 'ended';
    return { id: row.id, workspaceId: row.workspace_id, pageId: row.page_id, includeChildren: row.include_children, expiresAt: row.expires_at };
  }

  async recordView(shareId: string): Promise<void> {
    await this.pool.query('UPDATE page_share_links SET view_count = view_count + 1, last_viewed_at = now() WHERE id = $1 AND view_count < 2147483647',
      [shareId]);
  }

  async scope(access: ShareAccess): Promise<{ pages: SharedPageSummary[]; truncated: boolean }> {
    const result = await this.pool.query<{ id: string; parent_id: string | null; title: string; kind: SharedPageSummary['kind'] }>(
      `${scopeSql} SELECT id, parent_id, title, kind FROM scope ORDER BY depth, sort_position, id LIMIT $5`,
      [access.workspaceId, access.pageId, access.includeChildren, sharedKinds, scopeLimit + 1]);
    return { pages: result.rows.slice(0, scopeLimit).map(row => ({ id: row.id,
      parentId: row.id === access.pageId ? null : row.parent_id, title: row.title, kind: row.kind })),
    truncated: result.rows.length > scopeLimit };
  }

  async page(access: ShareAccess, pageId: string): Promise<SharedPageResponse | null> {
    const result = await this.pool.query<{ id: string; title: string; kind: SharedPageResponse['kind']; updated_at: Date;
      content_json: NonNullable<SharedPageResponse['content']> }>(`${scopeSql}
      SELECT p.id, p.title, p.kind, p.updated_at, p.content_json FROM scope s
      JOIN pages p ON p.workspace_id = $1 AND p.id = s.id WHERE s.id = $5`,
    [access.workspaceId, access.pageId, access.includeChildren, sharedKinds, pageId]);
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, title: row.title, kind: row.kind, updatedAt: row.updated_at.toISOString(),
      ...(row.kind === 'document' ? { content: row.content_json } : {}) };
  }

  /** Whether a shared document's current content references the attachment. */
  async referencesAttachment(access: ShareAccess, attachmentId: string): Promise<boolean> {
    const result = await this.pool.query<{ content_json: NonNullable<SharedPageResponse['content']> }>(`${scopeSql}
      SELECT p.content_json FROM scope s JOIN pages p ON p.workspace_id = $1 AND p.id = s.id
      WHERE s.kind = 'document' AND strpos(p.content_json::text, $5) > 0`,
    [access.workspaceId, access.pageId, access.includeChildren, sharedKinds, attachmentId]);
    return result.rows.some(row => attachmentReferences(row.content_json).some(item => item.id.toLowerCase() === attachmentId));
  }
}
