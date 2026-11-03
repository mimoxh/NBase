import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

const advisoryLockKey = '2026102502';
const loginPattern = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export interface OwnerIdentity {
  userId: string;
  workspaceId: string;
}

export async function initializeOwner(
  pool: Pick<Pool, 'connect'>,
  loginName: string,
  passwordHash: string,
  workspaceName: string,
): Promise<OwnerIdentity> {
  if (!loginPattern.test(loginName)) throw new Error('Owner login must be 3-64 lowercase ASCII characters');
  if (workspaceName.length < 1 || workspaceName.length > 200) throw new Error('Workspace name must be 1-200 characters');

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [advisoryLockKey]);
    const initialized = await client.query('SELECT owner_user_id FROM instance_state WHERE singleton = true');
    if (initialized.rowCount !== 0) throw new Error('NBase owner is already initialized');

    const userId = randomUUID();
    const workspaceId = randomUUID();
    await client.query(
      'INSERT INTO users (id, login_name, password_hash) VALUES ($1, $2, $3)',
      [userId, loginName, passwordHash],
    );
    await client.query(
      'INSERT INTO workspaces (id, name, owner_user_id) VALUES ($1, $2, $3)',
      [workspaceId, workspaceName, userId],
    );
    await client.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [workspaceId, userId],
    );
    await client.query(
      'INSERT INTO instance_state (singleton, owner_user_id, owner_workspace_id) VALUES (true, $1, $2)',
      [userId, workspaceId],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return { userId, workspaceId };
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* Keep the original initialization error. */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
