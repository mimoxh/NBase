import pg from 'pg';
import { runMigrations } from '../db/migrate.js';
import { hashPassword } from './password.js';
import { initializeOwner } from './initialize-owner.js';
import { databaseConfig, readSecretFile } from '../config.js';

const loginName = process.env.NBASE_OWNER_LOGIN;
const passwordFile = process.env.NBASE_OWNER_PASSWORD_FILE;
const workspaceName = process.env.NBASE_OWNER_WORKSPACE_NAME ?? '我的空间';
if (!loginName || !passwordFile) {
  throw new Error('NBASE_OWNER_LOGIN and NBASE_OWNER_PASSWORD_FILE are required');
}

const password = await readSecretFile(passwordFile);
const passwordHash = await hashPassword(password);

const pool = new pg.Pool({ ...await databaseConfig(process.env, true), max: 2 });
try {
  await runMigrations(pool);
  const owner = await initializeOwner(pool, loginName, passwordHash, workspaceName);
  process.stdout.write(`NBase owner initialized: ${loginName}; workspace ${owner.workspaceId}.\n`);
} catch (error) {
  console.error('NBase owner initialization failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
