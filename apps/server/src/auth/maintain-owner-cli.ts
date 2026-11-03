import pg from 'pg';
import { databaseConfig, readSecretFile } from '../config.js';
import { runMigrations } from '../db/migrate.js';
import { hashPassword } from './password.js';
import { maintainOwner } from './maintain-owner.js';

let pool: pg.Pool | undefined;
try {
  const action = process.argv[2];
  if (process.argv.length !== 3 || !['reset-password', 'revoke-sessions'].includes(action ?? '')) {
    throw new Error('Usage: maintain-owner <reset-password|revoke-sessions>');
  }
  const loginName = process.env.NBASE_OWNER_LOGIN;
  if (!loginName) throw new Error('NBASE_OWNER_LOGIN must explicitly identify this instance owner');
  const passwordFile = process.env.NBASE_OWNER_PASSWORD_FILE;
  if (action === 'reset-password' && !passwordFile) throw new Error('NBASE_OWNER_PASSWORD_FILE is required for reset-password');
  const passwordHash = action === 'reset-password' ? await hashPassword(await readSecretFile(passwordFile!)) : undefined;
  pool = new pg.Pool({ ...await databaseConfig(process.env, true), max: 2 });
  await runMigrations(pool);
  const result = await maintainOwner(pool, loginName, passwordHash);
  process.stdout.write(`NBase owner ${action} complete; revoked sessions: ${result.revokedSessions}.\n`);
} catch (error) {
  console.error('NBase owner maintenance failed:', error);
  process.exitCode = 1;
} finally { await pool?.end(); }
