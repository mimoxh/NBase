import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  AuthSessionResponse, InvitableRole, InvitationLifetimeDays, InvitationLookupResponse, InvitationStatus, MemberRole,
  WorkspaceInvitation, WorkspaceMember,
} from '@nbase/contracts';
import { pendingInvitationLimit } from '@nbase/contracts';
import type { Pool, PoolClient } from 'pg';
import type { SessionTokens } from '../auth/session.js';
import { WorkspaceRouteError } from '../auth/workspace.js';

const invitationBytes = 32;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function newInvitationToken(): { token: string; tokenHash: Buffer } {
  const bytes = randomBytes(invitationBytes);
  return { token: bytes.toString('base64url'), tokenHash: createHash('sha256').update(bytes).digest() };
}

/** Null for anything that is not exactly the encoding `newInvitationToken` produces. */
export function invitationTokenHash(token: unknown): Buffer | null {
  if (typeof token !== 'string' || !tokenPattern.test(token)) return null;
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== invitationBytes || bytes.toString('base64url') !== token) return null;
  return createHash('sha256').update(bytes).digest();
}

interface MemberRow {
  user_id: string;
  login_name: string;
  role: MemberRole;
  created_at: Date;
  removed_at: Date | null;
  last_login_at: Date | null;
}

interface InvitationRow {
  id: string;
  workspace_id: string;
  token_hash: Buffer;
  role: InvitableRole;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  accepted_at: Date | null;
  accepted_login_name: string | null;
  expired: boolean;
}

const memberColumns = `m.user_id, u.login_name, m.role, m.created_at, m.removed_at,
  (SELECT max(s.created_at) FROM sessions s WHERE s.user_id = m.user_id) AS last_login_at`;
const invitationColumns = `i.id, i.workspace_id, i.token_hash, i.role, i.created_at, i.expires_at, i.revoked_at, i.accepted_at,
  au.login_name AS accepted_login_name, i.expires_at <= now() AS expired`;

function memberFromRow(row: MemberRow): WorkspaceMember {
  return { userId: row.user_id, loginName: row.login_name, role: row.role, joinedAt: row.created_at.toISOString(),
    removedAt: row.removed_at?.toISOString() ?? null, lastLoginAt: row.last_login_at?.toISOString() ?? null };
}

function invitationStatus(row: InvitationRow): InvitationStatus {
  if (row.accepted_at) return 'accepted';
  if (row.revoked_at) return 'revoked';
  return row.expired ? 'expired' : 'pending';
}

function invitationFromRow(row: InvitationRow): WorkspaceInvitation {
  return { id: row.id, role: row.role, status: invitationStatus(row), createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null,
    acceptedAt: row.accepted_at?.toISOString() ?? null, acceptedLoginName: row.accepted_login_name };
}

const statusErrors: Record<Exclude<InvitationStatus, 'pending'>, string> = {
  expired: 'INVITATION_EXPIRED', accepted: 'INVITATION_USED', revoked: 'INVITATION_REVOKED',
};

export class PgMemberRepository {
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
      if (open) { try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ } }
      throw error;
    } finally { client.release(); }
  }

  /** Same workspace row lock as page writes, so membership changes wait for writes already authorized. */
  private async lockAsOwner(client: PoolClient, workspaceId: string, actorId: string): Promise<void> {
    const result = await client.query<{ role: MemberRole }>(`SELECT m.role FROM workspaces w
      JOIN workspace_memberships m ON m.workspace_id = w.id AND m.user_id = $2 AND m.removed_at IS NULL
      WHERE w.id = $1 FOR UPDATE OF w`, [workspaceId, actorId]);
    if (!result.rows[0]) throw new WorkspaceRouteError(404, 'NOT_FOUND');
    if (result.rows[0].role !== 'owner') throw new WorkspaceRouteError(403, 'FORBIDDEN');
  }

  private async member(db: Pick<Pool, 'query'>, workspaceId: string, userId: string): Promise<WorkspaceMember | null> {
    const result = await db.query<MemberRow>(`SELECT ${memberColumns} FROM workspace_memberships m
      JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.user_id = $2`, [workspaceId, userId]);
    return result.rows[0] ? memberFromRow(result.rows[0]) : null;
  }

  /** The member row, locked; the owner and the caller cannot be changed here. */
  private async target(client: PoolClient, workspaceId: string, actorId: string, userId: string) {
    const result = await client.query<{ role: MemberRole; removed_at: Date | null }>(`SELECT role, removed_at
      FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`, [workspaceId, userId]);
    const row = result.rows[0];
    if (!row) throw new WorkspaceRouteError(404, 'NOT_FOUND');
    if (row.role === 'owner' || userId === actorId) throw new WorkspaceRouteError(409, 'MEMBER_OWNER');
    return row;
  }

  /** Ends every session of the account in the same transaction; auth_epoch rejects logins verified earlier. */
  private async signOut(client: PoolClient, userId: string): Promise<void> {
    await client.query('UPDATE users SET auth_epoch = auth_epoch + 1 WHERE id = $1', [userId]);
    await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  }

  async members(workspaceId: string): Promise<WorkspaceMember[]> {
    const result = await this.pool.query<MemberRow>(`SELECT ${memberColumns} FROM workspace_memberships m
      JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1
      ORDER BY m.role = 'owner' DESC, m.removed_at IS NOT NULL, m.created_at, u.login_name`, [workspaceId]);
    return result.rows.map(memberFromRow);
  }

  /** Signs the member out, so open tabs pick up the new role at the next sign-in. */
  async setRole(workspaceId: string, actorId: string, userId: string, role: InvitableRole): Promise<WorkspaceMember> {
    return this.transaction(async client => {
      await this.lockAsOwner(client, workspaceId, actorId);
      const row = await this.target(client, workspaceId, actorId, userId);
      if (row.role !== role) {
        await client.query('UPDATE workspace_memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2',
          [workspaceId, userId, role]);
        await this.signOut(client, userId);
      }
      return (await this.member(client, workspaceId, userId))!;
    });
  }

  async remove(workspaceId: string, actorId: string, userId: string): Promise<WorkspaceMember> {
    return this.transaction(async client => {
      await this.lockAsOwner(client, workspaceId, actorId);
      const row = await this.target(client, workspaceId, actorId, userId);
      if (row.removed_at === null) {
        await client.query('UPDATE workspace_memberships SET removed_at = now() WHERE workspace_id = $1 AND user_id = $2',
          [workspaceId, userId]);
        await this.signOut(client, userId);
        // Authorizations in progress hold secrets for this member only; finished calendar sources stay with the workspace.
        await client.query('DELETE FROM calendar_oauth_flows WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]);
      }
      return (await this.member(client, workspaceId, userId))!;
    });
  }

  async restore(workspaceId: string, actorId: string, userId: string): Promise<WorkspaceMember> {
    return this.transaction(async client => {
      await this.lockAsOwner(client, workspaceId, actorId);
      const row = await this.target(client, workspaceId, actorId, userId);
      if (row.removed_at !== null) {
        await client.query('UPDATE workspace_memberships SET removed_at = NULL WHERE workspace_id = $1 AND user_id = $2',
          [workspaceId, userId]);
      }
      return (await this.member(client, workspaceId, userId))!;
    });
  }

  async invitations(workspaceId: string): Promise<WorkspaceInvitation[]> {
    const result = await this.pool.query<InvitationRow>(`SELECT ${invitationColumns} FROM workspace_invitations i
      LEFT JOIN users au ON au.id = i.accepted_user_id
      WHERE i.workspace_id = $1 ORDER BY i.created_at DESC, i.id LIMIT 200`, [workspaceId]);
    return result.rows.map(invitationFromRow);
  }

  private async invitation(db: Pick<Pool, 'query'>, workspaceId: string, id: string): Promise<InvitationRow | null> {
    const result = await db.query<InvitationRow>(`SELECT ${invitationColumns} FROM workspace_invitations i
      LEFT JOIN users au ON au.id = i.accepted_user_id WHERE i.workspace_id = $1 AND i.id = $2`, [workspaceId, id]);
    return result.rows[0] ?? null;
  }

  async createInvitation(workspaceId: string, actorId: string, role: InvitableRole,
    days: InvitationLifetimeDays): Promise<{ invitation: WorkspaceInvitation; token: string }> {
    return this.transaction(async client => {
      await this.lockAsOwner(client, workspaceId, actorId);
      const pending = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_invitations
        WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, [workspaceId]);
      if ((pending.rows[0]?.n ?? 0) >= pendingInvitationLimit) throw new WorkspaceRouteError(409, 'INVITATION_LIMIT');
      const { token, tokenHash } = newInvitationToken();
      const id = randomUUID();
      await client.query(`INSERT INTO workspace_invitations (id, workspace_id, token_hash, role, created_by, expires_at)
        VALUES ($1, $2, $3, $4, $5, now() + $6 * interval '1 day')`, [id, workspaceId, tokenHash, role, actorId, days]);
      return { invitation: invitationFromRow((await this.invitation(client, workspaceId, id))!), token };
    });
  }

  /** Idempotent; an accepted invitation cannot be revoked because the member already exists. */
  async revokeInvitation(workspaceId: string, actorId: string, id: string): Promise<WorkspaceInvitation> {
    return this.transaction(async client => {
      await this.lockAsOwner(client, workspaceId, actorId);
      const locked = await client.query<{ accepted_at: Date | null; revoked_at: Date | null }>(`SELECT accepted_at, revoked_at
        FROM workspace_invitations WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, [workspaceId, id]);
      const row = locked.rows[0];
      if (!row) throw new WorkspaceRouteError(404, 'NOT_FOUND');
      if (row.accepted_at) throw new WorkspaceRouteError(409, 'INVITATION_USED');
      if (!row.revoked_at) {
        await client.query('UPDATE workspace_invitations SET revoked_at = now() WHERE workspace_id = $1 AND id = $2', [workspaceId, id]);
      }
      return invitationFromRow((await this.invitation(client, workspaceId, id))!);
    });
  }

  private async byToken(db: Pick<Pool, 'query'>, tokenHash: Buffer, lock: boolean): Promise<(InvitationRow & { workspace_name: string }) | null> {
    const result = await db.query<InvitationRow & { workspace_name: string }>(`SELECT ${invitationColumns}, w.name AS workspace_name
      FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id
      LEFT JOIN users au ON au.id = i.accepted_user_id WHERE i.token_hash = $1${lock ? ' FOR UPDATE OF i' : ''}`, [tokenHash]);
    const row = result.rows[0];
    // The index lookup already matched; this keeps the final comparison independent of where the digests differ.
    return row && row.token_hash.length === tokenHash.length && timingSafeEqual(row.token_hash, tokenHash) ? row : null;
  }

  async lookup(tokenHash: Buffer): Promise<InvitationLookupResponse | null> {
    const row = await this.byToken(this.pool, tokenHash, false);
    if (!row) return null;
    const status = invitationStatus(row);
    return status === 'pending'
      ? { status, workspaceName: row.workspace_name, role: row.role, expiresAt: row.expires_at.toISOString() }
      : { status };
  }

  async loginTaken(loginName: string): Promise<boolean> {
    return (await this.pool.query('SELECT 1 FROM users WHERE login_name = $1', [loginName])).rowCount !== 0;
  }

  /** Locks the invitation, creates the account and membership, marks the invitation used and opens a session. */
  async accept(tokenHash: Buffer, loginName: string, passwordHash: string, tokens: SessionTokens): Promise<AuthSessionResponse> {
    return this.transaction(async client => {
      const located = await this.byToken(client, tokenHash, false);
      if (!located) throw new WorkspaceRouteError(404, 'INVITATION_NOT_FOUND');
      await client.query('SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE', [located.workspace_id]);
      const row = await this.byToken(client, tokenHash, true);
      if (!row) throw new WorkspaceRouteError(404, 'INVITATION_NOT_FOUND');
      const status = invitationStatus(row);
      if (status !== 'pending') throw new WorkspaceRouteError(409, statusErrors[status]);
      const userId = randomUUID();
      const inserted = await client.query(`INSERT INTO users (id, login_name, password_hash) VALUES ($1, $2, $3)
        ON CONFLICT (login_name) DO NOTHING`, [userId, loginName, passwordHash]);
      if (inserted.rowCount !== 1) throw new WorkspaceRouteError(409, 'LOGIN_TAKEN');
      await client.query('INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)',
        [row.workspace_id, userId, row.role]);
      await client.query('UPDATE workspace_invitations SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1', [row.id, userId]);
      await client.query('INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), userId, tokens.tokenHash, tokens.csrfHash, tokens.expiresAt]);
      return { user: { id: userId, loginName }, workspaces: [{ id: row.workspace_id, name: row.workspace_name, role: row.role }],
        csrfToken: tokens.csrfToken, expiresAt: tokens.expiresAt.toISOString() };
    });
  }
}
