import { randomUUID } from 'node:crypto';
import type { AuthWorkspace } from '@nbase/contracts';
import type { Pool } from 'pg';
import type { SessionTokens } from './session.js';

export interface AccountRecord {
  id: string;
  loginName: string;
  passwordHash: string;
  authEpoch: string;
  disabled: boolean;
}

export interface StoredSession {
  userId: string;
  loginName: string;
  csrfHash: Buffer;
  expiresAt: Date;
  revoked: boolean;
  disabled: boolean;
}

export interface AuthRepository {
  findAccount(loginName: string): Promise<AccountRecord | null>;
  createSession(account: AccountRecord, tokens: SessionTokens): Promise<boolean>;
  loadSession(tokenHash: Buffer): Promise<StoredSession | null>;
  revokeSession(tokenHash: Buffer): Promise<void>;
  workspacesForUser(userId: string): Promise<AuthWorkspace[]>;
}

interface AccountRow {
  id: string;
  login_name: string;
  password_hash: string;
  auth_epoch: string;
  disabled_at: Date | null;
}

interface SessionRow {
  user_id: string;
  login_name: string;
  csrf_hash: Buffer;
  expires_at: Date;
  revoked_at: Date | null;
  disabled_at: Date | null;
}

export class PgAuthRepository implements AuthRepository {
  constructor(private readonly pool: Pick<Pool, 'query' | 'connect'>) {}

  async findAccount(loginName: string): Promise<AccountRecord | null> {
    const result = await this.pool.query<AccountRow>(
      'SELECT id, login_name, password_hash, auth_epoch, disabled_at FROM users WHERE login_name = $1',
      [loginName],
    );
    const row = result.rows[0];
    return row ? { id: row.id, loginName: row.login_name, passwordHash: row.password_hash,
      authEpoch: row.auth_epoch, disabled: row.disabled_at !== null } : null;
  }

  async createSession(account: AccountRecord, tokens: SessionTokens): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize with owner maintenance after slow password verification has finished.
      const result = await client.query<AccountRow>(
        'SELECT password_hash, auth_epoch, disabled_at FROM users WHERE id = $1 FOR UPDATE', [account.id]);
      const row = result.rows[0];
      if (!row || row.disabled_at !== null || row.password_hash !== account.passwordHash || row.auth_epoch !== account.authEpoch) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        'INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), account.id, tokens.tokenHash, tokens.csrfHash, tokens.expiresAt],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    } finally { client.release(); }
  }

  async loadSession(tokenHash: Buffer): Promise<StoredSession | null> {
    const result = await this.pool.query<SessionRow>(`
      SELECT s.user_id, u.login_name, s.csrf_hash, s.expires_at, s.revoked_at, u.disabled_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
    `, [tokenHash]);
    const row = result.rows[0];
    return row ? {
      userId: row.user_id,
      loginName: row.login_name,
      csrfHash: row.csrf_hash,
      expiresAt: row.expires_at,
      revoked: row.revoked_at !== null,
      disabled: row.disabled_at !== null,
    } : null;
  }

  async revokeSession(tokenHash: Buffer): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [tokenHash],
    );
  }

  async workspacesForUser(userId: string): Promise<AuthWorkspace[]> {
    const result = await this.pool.query<{ id: string; name: string; role: AuthWorkspace['role'] }>(`
      SELECT w.id, w.name, m.role
      FROM workspace_memberships m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1
      ORDER BY w.created_at, w.id
    `, [userId]);
    return result.rows.map((row) => ({ id: row.id, name: row.name, role: row.role }));
  }
}
