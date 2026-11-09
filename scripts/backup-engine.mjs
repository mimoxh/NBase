// Offline maintenance engine. Run only against trusted NBase backup bundles.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hashPattern = /^[0-9a-f]{64}$/;
const imagePattern = /^sha256:[0-9a-f]{64}$/;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const attachmentPattern = new RegExp(`^${uuid}-${uuid}$`);
const baseTables = {
  schema_migrations: 'version', users: 'id', workspaces: 'id',
  workspace_memberships: 'workspace_id, user_id', instance_state: 'singleton', pages: 'id',
  page_versions: 'workspace_id, page_id, revision',
  page_mutation_receipts: 'workspace_id, actor_user_id, client_mutation_id', attachments: 'id',
  page_favorites: 'workspace_id, user_id, page_id',
};

function tablesForSchema(version) {
  return {
    ...baseTables,
    ...(version >= 7 ? { workspace_tags: 'workspace_id, id', page_tags: 'workspace_id, page_id, tag_id' } : {}),
    ...(version >= 8 ? { note_templates: 'workspace_id, owner_user_id, id' } : {}),
    ...(version >= 10 ? { page_links: 'workspace_id, source_page_id, occurrence' } : {}),
    ...(version >= 13 ? { databases: 'workspace_id, page_id' } : {}),
    ...(version >= 16 ? { database_row_links: 'workspace_id, property_id, source_row_id, target_row_id' } : {}),
    ...(version >= 17 ? { database_computed: 'workspace_id, row_id', database_computed_dirty: 'workspace_id, row_id' } : {}),
  };
}
const backupLock = '2026110301';
const maxManifestBytes = 64 * 1024 * 1024;
const maxAttachmentBytes = 10 * 1024 * 1024;

function requireValue(condition, message) { if (!condition) throw new Error(message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function regularFile(path) {
  const info = await lstat(path);
  requireValue(info.isFile() && !info.isSymbolicLink(), `Expected a regular file: ${path}`);
  return info;
}
async function directory(path) {
  requireValue(isAbsolute(path), 'Maintenance paths must be absolute');
  const info = await lstat(path);
  requireValue(info.isDirectory() && !info.isSymbolicLink(), `Expected a directory: ${path}`);
}
async function smallFile(path, limit) {
  const info = await regularFile(path);
  requireValue(info.size <= limit, 'Metadata file exceeds its size limit');
  return readFile(path);
}
async function fileHash(path) {
  const before = await regularFile(path);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const hash = createHash('sha256');
  let size = 0;
  try {
    const opened = await handle.stat();
    requireValue(opened.isFile() && opened.ino === before.ino && opened.dev === before.dev, 'File changed while opening');
    for await (const chunk of handle.createReadStream({ autoClose: false })) { size += chunk.length; hash.update(chunk); }
    const after = await handle.stat();
    requireValue(size === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs, 'File changed during hashing');
  } finally { await handle.close(); }
  return { size, sha256: hash.digest('hex') };
}
export async function copyVerified(source, destination, expected) {
  const before = await regularFile(source);
  const input = await open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let output;
  const hash = createHash('sha256');
  let size = 0;
  try {
    const opened = await input.stat();
    requireValue(opened.isFile() && opened.ino === before.ino && opened.dev === before.dev, 'Source file changed while opening');
    output = await open(destination, 'wx', 0o600);
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      size += chunk.length;
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const result = await output.write(chunk, written, chunk.length - written, null);
        requireValue(result.bytesWritten > 0, 'Could not write attachment bytes');
        written += result.bytesWritten;
      }
    }
    const after = await input.stat();
    requireValue(size === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs, 'Source file changed while copying');
    await output.sync();
    const actual = { size, sha256: hash.digest('hex') };
    if (expected) requireValue(actual.size === expected.size && actual.sha256 === expected.sha256, 'Copied attachment differs from the verified manifest');
    return actual;
  } finally { await Promise.allSettled([input.close(), ...(output ? [output.close()] : [])]); }
}
function sameKeys(actual, expected, message) {
  requireValue(JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()), message);
}
function validRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validateManifest(manifest) {
  requireValue(validRecord(manifest) && manifest.format === 'nbase-backup' && manifest.formatVersion === 1, 'Unsupported backup manifest');
  requireValue(imagePattern.test(manifest.appImageId) && imagePattern.test(manifest.postgresImageId), 'Backup image identities are missing or invalid');
  requireValue(typeof manifest.appVersion === 'string' && manifest.appVersion.length < 100, 'Invalid application version');
  requireValue(Number.isInteger(manifest.postgresMajor) && manifest.postgresMajor >= 18 && manifest.postgresMajor < 100, 'Invalid PostgreSQL major');
  requireValue(typeof manifest.createdAt === 'string' && Number.isFinite(Date.parse(manifest.createdAt)), 'Invalid backup date');
  requireValue(validRecord(manifest.dump) && hashPattern.test(manifest.dump.sha256)
    && Number.isSafeInteger(manifest.dump.size) && manifest.dump.size > 0, 'Invalid dump metadata');
  requireValue(Array.isArray(manifest.migrations) && manifest.migrations.length > 0 && manifest.migrations.length <= 1000, 'Invalid migration manifest');
  let previous = 0;
  for (const migration of manifest.migrations) {
    requireValue(validRecord(migration) && Number.isSafeInteger(migration.version) && migration.version > previous
      && typeof migration.name === 'string' && hashPattern.test(migration.checksum), 'Invalid migration entry');
    previous = migration.version;
  }
  const tables = tablesForSchema(manifest.migrations.at(-1).version);
  for (const field of ['tableCounts', 'tableDigests']) {
    requireValue(validRecord(manifest[field]), `Missing ${field}`);
    sameKeys(Object.keys(manifest[field]), Object.keys(tables), 'Backup table set differs from the supported NBase schema');
  }
  for (const table of Object.keys(tables)) {
    requireValue(/^\d+$/.test(manifest.tableCounts[table]) && hashPattern.test(manifest.tableDigests[table]), 'Invalid table verification metadata');
  }
  requireValue(Array.isArray(manifest.attachments) && manifest.attachments.length <= 1000000, 'Invalid attachment inventory');
  const names = new Set();
  for (const file of manifest.attachments) {
    requireValue(validRecord(file) && attachmentPattern.test(file.name) && !names.has(file.name)
      && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= maxAttachmentBytes && hashPattern.test(file.sha256), 'Invalid attachment entry');
    names.add(file.name);
  }
  requireValue(Array.isArray(manifest.attachmentMetadata), 'Missing attachment database inventory');
  const metadataNames = new Set();
  const inventory = new Map(manifest.attachments.map(item => [item.name, item]));
  for (const file of manifest.attachmentMetadata) {
    const stored = inventory.get(file.name);
    requireValue(validRecord(file) && attachmentPattern.test(file.name) && !metadataNames.has(file.name)
      && stored && stored.size === file.size && stored.sha256 === file.sha256, 'Attachment metadata does not match stored files');
    metadataNames.add(file.name);
  }
  requireValue(String(manifest.attachmentMetadata.length) === manifest.tableCounts.attachments, 'Attachment row count does not match its metadata inventory');
}

export async function verifyBundle(root) {
  await directory(root);
  sameKeys(await readdir(root), ['database.dump', 'attachments', 'manifest.json', 'COMPLETE'], 'Backup bundle has missing or unexpected entries');
  await directory(join(root, 'attachments'));
  const rawManifest = await smallFile(join(root, 'manifest.json'), maxManifestBytes);
  const complete = (await smallFile(join(root, 'COMPLETE'), 128)).toString('utf8').trim();
  requireValue(hashPattern.test(complete) && sha256(rawManifest) === complete, 'Backup is incomplete or the manifest checksum differs');
  const manifest = JSON.parse(rawManifest.toString('utf8'));
  validateManifest(manifest);
  sameKeys(await readdir(join(root, 'attachments')), manifest.attachments.map(item => item.name), 'Backup attachment files differ from the manifest');
  const dump = await fileHash(join(root, 'database.dump'));
  requireValue(dump.size === manifest.dump.size && dump.sha256 === manifest.dump.sha256, 'Database dump checksum differs');
  for (const file of manifest.attachments) {
    const actual = await fileHash(join(root, 'attachments', file.name));
    requireValue(actual.size === file.size && actual.sha256 === file.sha256, `Attachment checksum differs: ${file.name}`);
  }
  return manifest;
}

async function runProgram(program, args, env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(program, args, { shell: false, windowsHide: true, env,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors = (errors + data).slice(-5000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveResult(output.trim()) : reject(new Error(`${program} failed (${code}): ${errors}`)));
  });
}
async function connectDatabase() {
  const [{ default: pg }, { databaseConfig }, { migrations }] = await Promise.all([
    import('pg'), import('../apps/server/dist/config.js'), import('../apps/server/dist/db/migrations.js'),
  ]);
  const config = await databaseConfig(process.env, true);
  requireValue(config && !config.connectionString && config.host && config.database && config.user && typeof config.password === 'string',
    'Backup engine requires the Compose database fields and password file');
  const pool = new pg.Pool({ ...config, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("SET timezone = 'UTC'");
    const lock = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [backupLock]);
    requireValue(lock.rows[0].acquired, 'Another backup or restore is using this database');
    const version = await client.query('SHOW server_version_num');
    const postgresVersionNum = Number(version.rows[0].server_version_num);
    const postgresMajor = Math.floor(postgresVersionNum / 10000);
    const childEnv = { ...process.env, PGHOST: config.host, PGPORT: String(config.port ?? 5432),
      PGUSER: config.user, PGDATABASE: config.database, PGPASSWORD: config.password, PGTZ: 'UTC' };
    delete childEnv.PGSERVICE;
    delete childEnv.PGSERVICEFILE;
    const clientVersion = await runProgram('pg_dump', ['--version'], childEnv);
    requireValue(Number(/PostgreSQL\) (\d+)/.exec(clientVersion)?.[1]) === postgresMajor, 'PostgreSQL client/server major versions must match');
    const expectedMigrations = migrations.map(item => ({ version: item.version, name: item.name, checksum: sha256(item.sql) }));
    return { pool, client, childEnv, expectedMigrations, postgresMajor, postgresVersionNum, clientVersion };
  } catch (error) { client.release(); await pool.end(); throw error; }
}
async function schema(client) {
  const migrations = await client.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  const tables = tablesForSchema(migrations.rows.at(-1)?.version ?? 0);
  const objects = await client.query(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','m','v','f') ORDER BY relname`);
  sameKeys(objects.rows.map(row => row.relname), [...Object.keys(tables), 'sessions'], 'Database schema contains missing or unsupported tables/views');
  return { migrations: migrations.rows, tables };
}
async function tableInventory(client, tables) {
  const tableCounts = {}, tableDigests = {};
  for (const [table, order] of Object.entries(tables)) {
    const hash = createHash('sha256');
    let count = 0n;
    // Names and order are fixed above, never taken from a bundle or user input.
    await client.query(`DECLARE nbase_rows NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS row FROM public.${table} t ORDER BY ${order}`);
    try {
      for (;;) {
        const batch = await client.query('FETCH FORWARD 20 FROM nbase_rows');
        if (!batch.rows.length) break;
        for (const item of batch.rows) { hash.update(item.row).update('\n'); count += 1n; }
      }
    } finally { await client.query('CLOSE nbase_rows'); }
    tableCounts[table] = count.toString();
    tableDigests[table] = hash.digest('hex');
  }
  return { tableCounts, tableDigests };
}
async function attachmentMetadata(client) {
  const result = await client.query(`SELECT workspace_id::text || '-' || id::text AS name,
    byte_size AS size, encode(sha256,'hex') AS sha256 FROM attachments ORDER BY workspace_id,id`);
  return result.rows;
}
async function pgTransaction(client, callback) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try { const result = await callback(); await client.query('COMMIT'); return result; }
  catch (error) { try { await client.query('ROLLBACK'); } catch { /* Keep the original failure. */ } throw error; }
}
function matchingMigrations(actual, expected) {
  requireValue(JSON.stringify(actual) === JSON.stringify(expected), 'Migration versions or checksums differ from this maintenance image');
}
async function backup(root, attachments) {
  await directory(root);
  await directory(attachments);
  requireValue((await readdir(root)).length === 0, 'Backup destination must be empty');
  requireValue(imagePattern.test(process.env.NBASE_BACKUP_APP_IMAGE_ID) && imagePattern.test(process.env.NBASE_BACKUP_POSTGRES_IMAGE_ID), 'Backup requires exact application/PostgreSQL image identities');
  const db = await connectDatabase();
  let completionHash;
  try {
    await pgTransaction(db.client, async () => {
      await db.client.query("SET LOCAL lock_timeout = '5s'");
      const { migrations, tables } = await schema(db.client);
      matchingMigrations(migrations, db.expectedMigrations);
      await db.client.query(`LOCK TABLE ${[...Object.keys(tables), 'sessions'].map(name => `public.${name}`).join(', ')} IN SHARE MODE`);
      const snapshot = await db.client.query('SELECT pg_export_snapshot() AS id');
      const inventory = await tableInventory(db.client, tables);
      const metadata = await attachmentMetadata(db.client);
      await mkdir(join(root, 'attachments'), { mode: 0o700 });
      const files = [];
      for (const name of (await readdir(attachments)).sort()) {
        requireValue(attachmentPattern.test(name), `Unexpected attachment volume entry: ${name}`);
        const info = await regularFile(join(attachments, name));
        requireValue(info.size > 0 && info.size <= maxAttachmentBytes, 'Invalid attachment file size');
        files.push({ name, ...await copyVerified(join(attachments, name), join(root, 'attachments', name)) });
      }
      const source = new Map(files.map(file => [file.name, file]));
      for (const file of metadata) {
        const actual = source.get(file.name);
        requireValue(actual && actual.size === file.size && actual.sha256 === file.sha256, `Database attachment is missing or corrupt: ${file.name}`);
      }
      const dumpPath = join(root, 'database.dump');
      await runProgram('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--exclude-table-data=public.sessions',
        `--snapshot=${snapshot.rows[0].id}`, `--file=${dumpPath}`], db.childEnv);
      const app = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      const manifest = { format: 'nbase-backup', formatVersion: 1, createdAt: new Date().toISOString(),
        appVersion: app.version, appImageId: process.env.NBASE_BACKUP_APP_IMAGE_ID,
        postgresImageId: process.env.NBASE_BACKUP_POSTGRES_IMAGE_ID, postgresMajor: db.postgresMajor,
        postgresVersionNum: db.postgresVersionNum, clientVersion: db.clientVersion,
        migrations, ...inventory, attachments: files, attachmentMetadata: metadata, dump: await fileHash(dumpPath) };
      validateManifest(manifest);
      const raw = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
      requireValue(raw.length <= maxManifestBytes, 'Backup manifest exceeds the supported size');
      const manifestHandle = await open(join(root, 'manifest.json'), 'wx', 0o600);
      try { await manifestHandle.writeFile(raw); await manifestHandle.sync(); } finally { await manifestHandle.close(); }
      // COMPLETE is created only after all files have passed a second independent read.
      const expected = manifest.dump;
      const copied = await fileHash(dumpPath);
      requireValue(copied.size === expected.size && copied.sha256 === expected.sha256, 'Dump changed before completion');
      for (const file of files) {
        const actual = await fileHash(join(root, 'attachments', file.name));
        requireValue(actual.size === file.size && actual.sha256 === file.sha256, 'Attachment changed before completion');
      }
      completionHash = sha256(raw);
    });
    await writeFile(join(root, '.COMPLETE.tmp'), completionHash + '\n', { flag: 'wx', mode: 0o600 });
    await rename(join(root, '.COMPLETE.tmp'), join(root, 'COMPLETE'));
    await verifyBundle(root);
  } finally { db.client.release(); await db.pool.end(); }
}
async function restore(root, attachments) {
  const manifest = await verifyBundle(root);
  requireValue(process.env.NBASE_BACKUP_APP_IMAGE_ID === manifest.appImageId, 'Restore application image must match the backup application image');
  await directory(attachments);
  requireValue((await readdir(attachments)).length === 0, 'Restore attachment target must be empty');
  const db = await connectDatabase();
  try {
    requireValue(db.postgresMajor === manifest.postgresMajor, 'Restore PostgreSQL major must match the backup');
    matchingMigrations(manifest.migrations, db.expectedMigrations);
    const occupied = await db.client.query(`SELECT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    ) AS occupied`);
    requireValue(!occupied.rows[0].occupied, 'Restore database target must be empty');
    for (const file of manifest.attachments) {
      await copyVerified(join(root, 'attachments', file.name), join(attachments, file.name), file);
    }
    const dump = await fileHash(join(root, 'database.dump'));
    requireValue(dump.size === manifest.dump.size && dump.sha256 === manifest.dump.sha256, 'Dump changed after verification');
    await runProgram('pg_restore', ['--single-transaction', '--exit-on-error', '--no-owner', '--no-acl',
      '--dbname=' + String(db.childEnv.PGDATABASE), join(root, 'database.dump')], db.childEnv);
    await pgTransaction(db.client, async () => {
      const { migrations, tables } = await schema(db.client);
      matchingMigrations(migrations, manifest.migrations);
      const actual = await tableInventory(db.client, tables);
      requireValue(JSON.stringify(actual.tableCounts) === JSON.stringify(manifest.tableCounts)
        && JSON.stringify(actual.tableDigests) === JSON.stringify(manifest.tableDigests), 'Restored database contents differ from the backup');
      requireValue(JSON.stringify(await attachmentMetadata(db.client)) === JSON.stringify(manifest.attachmentMetadata), 'Restored attachment metadata differs');
      await db.client.query('DELETE FROM sessions');
      await db.client.query('UPDATE users SET auth_epoch = auth_epoch + 1');
    });
  } finally { db.client.release(); await db.pool.end(); }
}

export async function main(action = process.argv[2], env = process.env) {
  requireValue(['backup', 'verify', 'restore'].includes(action), 'Usage: backup-engine <backup|verify|restore>');
  const root = env.NBASE_BACKUP_DIR;
  requireValue(typeof root === 'string', 'NBASE_BACKUP_DIR is required');
  if (action === 'verify') {
    const manifest = await verifyBundle(root);
    console.log(`Backup verified: ${manifest.createdAt}; schema ${manifest.migrations.at(-1).version}; ${manifest.attachments.length} attachment files.`);
  } else {
    const attachments = env.NBASE_ATTACHMENT_DIR;
    requireValue(typeof attachments === 'string', 'NBASE_ATTACHMENT_DIR is required');
    if (action === 'backup') await backup(root, attachments);
    else await restore(root, attachments);
    console.log(`NBase ${action} complete. Passwords and active sessions were not printed.`);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error('NBase backup operation failed:', error.message); process.exitCode = 1; });
}



