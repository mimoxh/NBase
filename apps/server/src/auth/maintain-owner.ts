import type { Pool } from 'pg';

/** Local operator only. No HTTP route calls this function. */
export async function maintainOwner(pool: Pick<Pool, 'connect'>, loginName: string, passwordHash?: string) {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(loginName)) throw new Error('Explicit owner login must be 3-64 lowercase ASCII characters');
  if (passwordHash !== undefined && !passwordHash.startsWith('scrypt:1:')) throw new Error('Expected a password hash');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string; login_name: string; disabled_at: Date | null }>(`
      SELECT u.id, u.login_name, u.disabled_at FROM users u
      JOIN instance_state i ON i.owner_user_id = u.id WHERE i.singleton = true FOR UPDATE OF u
    `);
    const owner = result.rows[0];
    if (!owner || owner.login_name !== loginName) throw new Error('Owner is not initialized or the login does not match this instance');
    if (owner.disabled_at !== null) throw new Error('Owner is disabled; maintenance does not enable accounts');
    await client.query(`UPDATE users SET auth_epoch = auth_epoch + 1,
      password_hash = COALESCE($2, password_hash) WHERE id = $1`, [owner.id, passwordHash ?? null]);
    const revoked = await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [owner.id]);
    await client.query('COMMIT');
    return { userId: owner.id, revokedSessions: revoked.rowCount ?? 0 };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
    throw error;
  } finally { client.release(); }
}
