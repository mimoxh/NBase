import { readFile, stat } from 'node:fs/promises';
import type { PoolConfig } from 'pg';
import { publicOriginConfig } from './auth/session.js';

/** A single trailing line ending is convenient for files created by text editors. */
export async function readSecretFile(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 4096) throw new Error('Secret file must be a file no larger than 4096 bytes');
  const value = (await readFile(path, 'utf8')).replace(/\r?\n$/, '');
  if (!value || /[\r\n\0]/.test(value)) throw new Error('Secret file must contain one non-empty line');
  return value;
}

export async function databaseConfig(env: NodeJS.ProcessEnv = process.env, required = false): Promise<PoolConfig | undefined> {
  const url = env.NBASE_DATABASE_URL;
  const keys = ['NBASE_DATABASE_HOST', 'NBASE_DATABASE_PORT', 'NBASE_DATABASE_NAME',
    'NBASE_DATABASE_USER', 'NBASE_DATABASE_PASSWORD_FILE'] as const;
  const hasFields = keys.some(key => env[key] !== undefined);
  if (url !== undefined && hasFields) throw new Error('Use NBASE_DATABASE_URL or database fields, not both');
  // No client-side query timeout for transactions: it does not cancel server SQL.
  const defaults = { connectionTimeoutMillis: 5000 };
  if (url !== undefined) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('NBASE_DATABASE_URL must be a PostgreSQL URL'); }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.pathname.length < 2) {
      throw new Error('NBASE_DATABASE_URL must name a dedicated PostgreSQL database');
    }
    return { ...defaults, connectionString: url };
  }
  if (!hasFields) {
    if (required) throw new Error('A dedicated NBase database configuration is required');
    return undefined;
  }
  if (!env.NBASE_DATABASE_HOST || !env.NBASE_DATABASE_NAME || !env.NBASE_DATABASE_USER || !env.NBASE_DATABASE_PASSWORD_FILE) {
    throw new Error('NBASE_DATABASE_HOST, NBASE_DATABASE_NAME, NBASE_DATABASE_USER and NBASE_DATABASE_PASSWORD_FILE are required together');
  }
  const port = Number(env.NBASE_DATABASE_PORT ?? '5432');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('NBASE_DATABASE_PORT is invalid');
  return { ...defaults, host: env.NBASE_DATABASE_HOST, port, database: env.NBASE_DATABASE_NAME,
    user: env.NBASE_DATABASE_USER, password: await readSecretFile(env.NBASE_DATABASE_PASSWORD_FILE) };
}

export async function serverConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.PORT ?? '3001');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  if (env.NBASE_REQUIRE_DATABASE !== undefined && !['0', '1'].includes(env.NBASE_REQUIRE_DATABASE)) {
    throw new Error('NBASE_REQUIRE_DATABASE must be 0 or 1');
  }
  const database = await databaseConfig(env, env.NBASE_REQUIRE_DATABASE === '1');
  const publicOrigin = env.NBASE_PUBLIC_ORIGIN;
  const attachmentDir = env.NBASE_ATTACHMENT_DIR;
  if (database) {
    if (!publicOrigin || !attachmentDir) throw new Error('NBASE_PUBLIC_ORIGIN and NBASE_ATTACHMENT_DIR are required for persistence');
    publicOriginConfig(publicOrigin); // Reject misconfiguration before touching the database.
  }
  return { host: env.HOST ?? '127.0.0.1', port, database, publicOrigin, attachmentDir };
}
