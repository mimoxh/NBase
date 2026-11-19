import type { CommentAnchor, CommentThread, MemberRef, PageComment } from '@nbase/contracts';
import { commentsPerThreadLimit, commentThreadsPerPageLimit } from '@nbase/contracts';
import type { Pool, PoolClient } from 'pg';
import { WorkspaceRouteError } from '../auth/workspace.js';

/** Page kinds whose content is a document and can carry comments. */
const commentableKinds = ['document', 'row'];

interface ThreadRow {
  id: string; page_id: string; anchor_block_id: string | null; anchor_path: number[]; quote: string;
  created_by: string; created_login: string; created_at: Date;
  resolved_at: Date | null; resolved_by: string | null; resolved_login: string | null;
}

interface CommentRow {
  id: string; thread_id: string; author_user_id: string; login_name: string; body: string; created_at: Date; edited_at: Date | null;
}

const threadColumns = `t.id, t.page_id, t.anchor_block_id, t.anchor_path, t.quote, t.created_by, cu.login_name AS created_login,
  t.created_at, t.resolved_at, t.resolved_by, ru.login_name AS resolved_login`;
const threadJoins = 'JOIN users cu ON cu.id = t.created_by LEFT JOIN users ru ON ru.id = t.resolved_by';

function ref(userId: string, loginName: string): MemberRef { return { userId, loginName }; }

function threadFromRows(row: ThreadRow, comments: CommentRow[]): CommentThread {
  return {
    id: row.id, pageId: row.page_id,
    anchor: { blockId: row.anchor_block_id, path: row.anchor_path, quote: row.quote },
    createdBy: ref(row.created_by, row.created_login), createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolvedBy: row.resolved_by ? ref(row.resolved_by, row.resolved_login ?? '') : null,
    comments: comments.map((item): PageComment => ({ id: item.id, author: ref(item.author_user_id, item.login_name), body: item.body,
      createdAt: item.created_at.toISOString(), editedAt: item.edited_at?.toISOString() ?? null })),
  };
}

const conflict = () => new WorkspaceRouteError(409, 'COMMENT_CONFLICT');
const notFound = () => new WorkspaceRouteError(404, 'NOT_FOUND');

/**
 * Discussions next to a page (docs/architecture/collaboration.md). They never touch the page row, its revision or
 * its history; a page in the trash hides its threads until it is restored. Routes authorize the member first.
 */
export class PgCommentRepository {
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

  /** Locks the page against concurrent thread creation, so the per-page limit holds. */
  private async lockPage(client: PoolClient, workspaceId: string, pageId: string): Promise<void> {
    const page = await client.query<{ kind: string }>(`SELECT kind FROM pages
      WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL FOR NO KEY UPDATE`, [workspaceId, pageId]);
    if (!page.rows[0]) throw notFound();
    if (!commentableKinds.includes(page.rows[0].kind)) throw new WorkspaceRouteError(422, 'PAGE_KIND_INVALID');
  }

  /** The thread with its page still out of the trash; locked when the caller changes it. */
  private async threadRow(db: Pick<PoolClient, 'query'>, workspaceId: string, threadId: string, lock: boolean): Promise<ThreadRow> {
    const result = await db.query<ThreadRow>(`SELECT ${threadColumns} FROM page_comment_threads t ${threadJoins}
      JOIN pages p ON p.workspace_id = t.workspace_id AND p.id = t.page_id AND p.deleted_at IS NULL
      WHERE t.workspace_id = $1 AND t.id = $2${lock ? ' FOR NO KEY UPDATE OF t' : ''}`, [workspaceId, threadId]);
    if (!result.rows[0]) throw notFound();
    return result.rows[0];
  }

  private async load(db: Pick<PoolClient, 'query'>, rows: ThreadRow[]): Promise<CommentThread[]> {
    if (!rows.length) return [];
    const comments = await db.query<CommentRow>(`SELECT c.id, c.thread_id, c.author_user_id, u.login_name, c.body,
      c.created_at, c.edited_at FROM page_comments c JOIN users u ON u.id = c.author_user_id
      WHERE c.thread_id = ANY($1::uuid[]) AND c.deleted_at IS NULL ORDER BY c.created_at, c.id`, [rows.map(row => row.id)]);
    const byThread = new Map<string, CommentRow[]>();
    for (const comment of comments.rows) {
      const list = byThread.get(comment.thread_id) ?? [];
      list.push(comment);
      byThread.set(comment.thread_id, list);
    }
    return rows.map(row => threadFromRows(row, byThread.get(row.id) ?? []));
  }

  private async thread(db: Pick<PoolClient, 'query'>, workspaceId: string, threadId: string): Promise<CommentThread> {
    return (await this.load(db, [await this.threadRow(db, workspaceId, threadId, false)]))[0]!;
  }

  /** Threads whose comments were all deleted are left out. */
  async list(workspaceId: string, pageId: string): Promise<CommentThread[]> {
    const page = await this.pool.query('SELECT 1 FROM pages WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL',
      [workspaceId, pageId]);
    if (!page.rows[0]) throw notFound();
    const rows = await this.pool.query<ThreadRow>(`SELECT ${threadColumns} FROM page_comment_threads t ${threadJoins}
      WHERE t.workspace_id = $1 AND t.page_id = $2 ORDER BY t.created_at, t.id`, [workspaceId, pageId]);
    return (await this.load(this.pool, rows.rows)).filter(thread => thread.comments.length > 0);
  }

  /** Same id from the same author on the same page returns the stored thread, so a retried request is harmless. */
  async create(workspaceId: string, actorId: string, pageId: string, threadId: string, commentId: string,
    anchor: CommentAnchor, body: string): Promise<{ created: boolean; thread: CommentThread }> {
    return this.transaction(async client => {
      await this.lockPage(client, workspaceId, pageId);
      const existing = await client.query<{ workspace_id: string; page_id: string; created_by: string }>(
        'SELECT workspace_id, page_id, created_by FROM page_comment_threads WHERE id = $1', [threadId]);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.workspace_id !== workspaceId.toLowerCase() || row.page_id !== pageId || row.created_by !== actorId) throw conflict();
        return { created: false, thread: await this.thread(client, workspaceId, threadId) };
      }
      if ((await client.query('SELECT 1 FROM page_comments WHERE id = $1', [commentId])).rows[0]) throw conflict();
      const count = await client.query<{ count: string }>(
        'SELECT count(*) FROM page_comment_threads WHERE workspace_id = $1 AND page_id = $2', [workspaceId, pageId]);
      if (Number(count.rows[0]!.count) >= commentThreadsPerPageLimit) throw new WorkspaceRouteError(422, 'COMMENT_LIMIT');
      await client.query(`INSERT INTO page_comment_threads (id, workspace_id, page_id, anchor_block_id, anchor_path, quote, created_by)
        VALUES ($1, $2, $3, $4, $5::integer[], $6, $7)`,
      [threadId, workspaceId, pageId, anchor.blockId, anchor.path, anchor.quote, actorId]);
      await client.query(`INSERT INTO page_comments (id, workspace_id, thread_id, author_user_id, body)
        VALUES ($1, $2, $3, $4, $5)`, [commentId, workspaceId, threadId, actorId, body]);
      return { created: true, thread: await this.thread(client, workspaceId, threadId) };
    });
  }

  async reply(workspaceId: string, actorId: string, threadId: string, commentId: string,
    body: string): Promise<{ created: boolean; thread: CommentThread }> {
    return this.transaction(async client => {
      await this.threadRow(client, workspaceId, threadId, true);
      const existing = await client.query<{ thread_id: string; author_user_id: string }>(
        'SELECT thread_id, author_user_id FROM page_comments WHERE id = $1', [commentId]);
      if (existing.rows[0]) {
        if (existing.rows[0].thread_id !== threadId || existing.rows[0].author_user_id !== actorId) throw conflict();
        return { created: false, thread: await this.thread(client, workspaceId, threadId) };
      }
      const count = await client.query<{ count: string }>('SELECT count(*) FROM page_comments WHERE thread_id = $1', [threadId]);
      if (Number(count.rows[0]!.count) >= commentsPerThreadLimit) throw new WorkspaceRouteError(422, 'COMMENT_LIMIT');
      await client.query(`INSERT INTO page_comments (id, workspace_id, thread_id, author_user_id, body)
        VALUES ($1, $2, $3, $4, $5)`, [commentId, workspaceId, threadId, actorId, body]);
      return { created: true, thread: await this.thread(client, workspaceId, threadId) };
    });
  }

  private async commentRow(client: PoolClient, workspaceId: string, commentId: string) {
    const result = await client.query<{ thread_id: string; author_user_id: string; deleted: boolean }>(`SELECT c.thread_id,
      c.author_user_id, c.deleted_at IS NOT NULL AS deleted FROM page_comments c
      JOIN page_comment_threads t ON t.id = c.thread_id
      JOIN pages p ON p.workspace_id = t.workspace_id AND p.id = t.page_id AND p.deleted_at IS NULL
      WHERE c.workspace_id = $1 AND c.id = $2 FOR NO KEY UPDATE OF c`, [workspaceId, commentId]);
    if (!result.rows[0]) throw notFound();
    return result.rows[0];
  }

  /** Only the author edits a comment. */
  async edit(workspaceId: string, actorId: string, commentId: string, body: string): Promise<CommentThread> {
    return this.transaction(async client => {
      const comment = await this.commentRow(client, workspaceId, commentId);
      if (comment.deleted) throw notFound();
      if (comment.author_user_id !== actorId) throw new WorkspaceRouteError(403, 'FORBIDDEN');
      await client.query(`UPDATE page_comments SET body = $2, edited_at = now() WHERE id = $1 AND body IS DISTINCT FROM $2`,
        [commentId, body]);
      return this.thread(client, workspaceId, comment.thread_id);
    });
  }

  /** The author or the workspace owner; deleting twice is not an error. */
  async remove(workspaceId: string, actorId: string, owner: boolean, commentId: string): Promise<CommentThread> {
    return this.transaction(async client => {
      const comment = await this.commentRow(client, workspaceId, commentId);
      if (comment.author_user_id !== actorId && !owner) throw new WorkspaceRouteError(403, 'FORBIDDEN');
      if (!comment.deleted) await client.query('UPDATE page_comments SET deleted_at = now() WHERE id = $1', [commentId]);
      return this.thread(client, workspaceId, comment.thread_id);
    });
  }

  /** Absolute state, so repeating it changes nothing. */
  async resolve(workspaceId: string, actorId: string, threadId: string, resolved: boolean): Promise<CommentThread> {
    return this.transaction(async client => {
      await this.threadRow(client, workspaceId, threadId, true);
      await client.query(resolved
        ? 'UPDATE page_comment_threads SET resolved_at = now(), resolved_by = $2 WHERE id = $1 AND resolved_at IS NULL'
        : 'UPDATE page_comment_threads SET resolved_at = NULL, resolved_by = NULL WHERE id = $1 AND $2::uuid IS NOT NULL',
      [threadId, actorId]);
      return this.thread(client, workspaceId, threadId);
    });
  }
}
