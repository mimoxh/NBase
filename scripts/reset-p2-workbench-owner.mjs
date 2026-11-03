// Recovery is intentionally restricted to the disposable local P2 workbench.
import pg from 'pg';
import { hashPassword } from '../apps/server/dist/auth/password.js';
import { readSecretFile } from '../apps/server/dist/config.js';
import { runMigrations } from '../apps/server/dist/db/migrate.js';
import { maintainOwner } from '../apps/server/dist/auth/maintain-owner.js';

const connectionString = process.env.NBASE_DATABASE_URL;
const passwordFile = process.env.NBASE_OWNER_PASSWORD_FILE;
if (!connectionString || !passwordFile) {
  throw new Error('NBASE_DATABASE_URL and NBASE_OWNER_PASSWORD_FILE are required');
}

const target = new URL(connectionString);
if (target.protocol !== 'postgresql:' || target.hostname !== '127.0.0.1'
  || target.port !== '54329' || target.pathname !== '/nbase_p2_workbench'
  || target.username !== 'nbase_p2' || target.search || target.hash) {
  throw new Error('Only the disposable local P2 workbench database is allowed');
}
const password = await readSecretFile(passwordFile);
const passwordHash = await hashPassword(password);

const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
try {
  await runMigrations(pool);
  await maintainOwner(pool, 'owner', passwordHash);
  process.stdout.write('Local workbench owner password reset; existing sessions revoked.\n');
} finally {
  await pool.end();
}
