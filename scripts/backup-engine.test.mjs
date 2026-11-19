import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyBundle, copyVerified, tablesForSchema } from './backup-engine.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nbase-bundle-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'attachments'));
  const name = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const bytes = Buffer.from('attachment fixture');
  const dump = Buffer.from('PGDMP test fixture (not restored in offline verification)');
  await writeFile(join(root, 'database.dump'), dump);
  await writeFile(join(root, 'attachments', name), bytes);
  const tableNames = ['schema_migrations', 'users', 'workspaces', 'workspace_memberships', 'instance_state',
    'pages', 'page_versions', 'page_mutation_receipts', 'attachments', 'page_favorites'];
  const file = { name, size: bytes.length, sha256: hash(bytes) };
  const manifest = { format: 'nbase-backup', formatVersion: 1, createdAt: new Date().toISOString(), appVersion: '0.1.0',
    appImageId: 'sha256:' + 'a'.repeat(64), postgresImageId: 'sha256:' + 'b'.repeat(64), postgresMajor: 18,
    migrations: [{ version: 1, name: 'test', checksum: 'c'.repeat(64) }],
    tableCounts: Object.fromEntries(tableNames.map(table => [table, table === 'attachments' ? '1' : '0'])),
    tableDigests: Object.fromEntries(tableNames.map(table => [table, hash('')])),
    attachments: [file], attachmentMetadata: [file], dump: { size: dump.length, sha256: hash(dump) } };
  const save = async () => { const raw = JSON.stringify(manifest); await writeFile(join(root, 'manifest.json'), raw); await writeFile(join(root, 'COMPLETE'), hash(raw) + '\n'); };
  await save();
  return { root, manifest, save, name };
}
test('offline verification accepts a complete bundle without loading pg or opening a network connection', async t => {
  const f = await fixture(t);
  assert.deepEqual(await verifyBundle(f.root), f.manifest);
});
test('dump corruption, missing attachments and incomplete markers are rejected', async t => {
  for (const kind of ['dump', 'attachment', 'marker']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'dump') await writeFile(join(f.root, 'database.dump'), 'damaged');
    if (kind === 'attachment') await unlink(join(f.root, 'attachments', f.name));
    if (kind === 'marker') await unlink(join(f.root, 'COMPLETE'));
    await assert.rejects(verifyBundle(f.root));
  });
});
test('path traversal and metadata inventory mismatch fail even with a recomputed manifest checksum', async t => {
  for (const kind of ['path', 'metadata', 'extra']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'path') f.manifest.attachments[0].name = '../escape';
    if (kind === 'metadata') f.manifest.attachmentMetadata = [];
    if (kind === 'extra') await writeFile(join(f.root, 'unexpected.txt'), 'unexpected');
    await f.save();
    await assert.rejects(verifyBundle(f.root));
  });
});
test('symlink attachments are rejected instead of following files outside the bundle', async t => {
  const f = await fixture(t);
  const content = await readFile(join(f.root, 'attachments', f.name));
  await writeFile(join(f.root, 'outside'), content);
  await unlink(join(f.root, 'attachments', f.name));
  try { await symlink(join(f.root, 'outside'), join(f.root, 'attachments', f.name)); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Creating symlinks requires OS privileges'); return; } throw error; }
  await unlink(join(f.root, 'outside'));
  await assert.rejects(verifyBundle(f.root));
});

test('schema 26 bundles must carry workspace invitations, earlier ones must not', async t => {
  assert.equal(tablesForSchema(25).workspace_invitations, undefined);
  assert.equal(tablesForSchema(26).workspace_invitations, 'id');
  const atVersion = async (version, drop) => {
    const f = await fixture(t);
    const tables = Object.keys(tablesForSchema(version)).filter(table => table !== drop);
    f.manifest.migrations = [{ version, name: 'test', checksum: 'c'.repeat(64) }];
    f.manifest.tableCounts = Object.fromEntries(tables.map(table => [table, table === 'attachments' ? '1' : '0']));
    f.manifest.tableDigests = Object.fromEntries(tables.map(table => [table, hash('')]));
    await f.save();
    return f;
  };
  const complete = await atVersion(26);
  assert.deepEqual(await verifyBundle(complete.root), complete.manifest);
  await assert.rejects(verifyBundle((await atVersion(26, 'workspace_invitations')).root), /table set differs/);
  const older = await atVersion(25);
  older.manifest.tableCounts.workspace_invitations = '0';
  older.manifest.tableDigests.workspace_invitations = hash('');
  await older.save();
  await assert.rejects(verifyBundle(older.root), /table set differs/);
});

test('schema v28 bundles carry comments and share links', async t => {
  assert.equal('page_share_links' in tablesForSchema(27), false);
  const tables = tablesForSchema(28);
  assert.deepEqual([tables.page_comment_threads, tables.page_comments, tables.page_share_links], ['id', 'id', 'id']);
  const f = await fixture(t);
  f.manifest.migrations = [{ version: 28, name: 'page_comments_and_shares', checksum: 'c'.repeat(64) }];
  f.manifest.tableCounts = Object.fromEntries(Object.keys(tables).map(table => [table, table === 'attachments' ? '1' : '0']));
  f.manifest.tableDigests = Object.fromEntries(Object.keys(tables).map(table => [table, hash('')]));
  await f.save();
  assert.deepEqual(await verifyBundle(f.root), f.manifest);
  delete f.manifest.tableCounts.page_comments;
  delete f.manifest.tableDigests.page_comments;
  await f.save();
  await assert.rejects(verifyBundle(f.root), /table set differs/);
});

test('attachment copy preserves bytes, refuses overwrite and detects mismatch', async t => {
  const f = await fixture(t);
  const source = join(f.root, 'attachments', f.name);
  const target = join(f.root, 'copied');
  const result = await copyVerified(source, target, f.manifest.attachments[0]);
  assert.equal(result.sha256, f.manifest.attachments[0].sha256);
  assert.deepEqual(await readFile(target), await readFile(source));
  await assert.rejects(copyVerified(source, target), /EEXIST/);
  await assert.rejects(copyVerified(source, join(f.root, 'mismatch'), {size: 1, sha256: '0'.repeat(64)}), /differs/);
});

test('schema v27 adds database schema history to the export inventory and the bundle summary', async t => {
  assert.equal('database_schema_versions' in tablesForSchema(26), false);
  assert.equal(tablesForSchema(27).database_schema_versions, 'workspace_id, database_id, revision');
  const f = await fixture(t);
  const tables = Object.keys(tablesForSchema(27));
  f.manifest.migrations = [{ version: 27, name: 'database_schema_versions', checksum: 'c'.repeat(64) }];
  f.manifest.tableCounts = Object.fromEntries(tables.map(table => [table, table === 'attachments' ? '1' : '0']));
  f.manifest.tableDigests = Object.fromEntries(tables.map(table => [table, hash('')]));
  await f.save();
  assert.deepEqual(await verifyBundle(f.root), f.manifest);
  delete f.manifest.tableCounts.database_schema_versions;
  delete f.manifest.tableDigests.database_schema_versions;
  await f.save();
  await assert.rejects(verifyBundle(f.root), /table set differs/);
});

test('schema v29 only adds page_versions.search_text: the table set stays that of v28', async t => {
  assert.deepEqual(tablesForSchema(29), tablesForSchema(28));
  const f = await fixture(t);
  const tables = Object.keys(tablesForSchema(29));
  f.manifest.migrations = [{ version: 29, name: 'page_version_search_text', checksum: 'c'.repeat(64) }];
  f.manifest.tableCounts = Object.fromEntries(tables.map(table => [table, table === 'attachments' ? '1' : '0']));
  f.manifest.tableDigests = Object.fromEntries(tables.map(table => [table, hash('')]));
  await f.save();
  assert.deepEqual(await verifyBundle(f.root), f.manifest);
});

test('schema v30 bundles carry the real-time room tables', async t => {
  assert.equal('page_collab_rooms' in tablesForSchema(29), false);
  const tables = tablesForSchema(30);
  assert.deepEqual([tables.page_collab_rooms, tables.page_collab_updates], ['workspace_id, page_id', 'workspace_id, page_id, epoch, seq']);
  const f = await fixture(t);
  f.manifest.migrations = [{ version: 30, name: 'page_collab_rooms', checksum: 'c'.repeat(64) }];
  f.manifest.tableCounts = Object.fromEntries(Object.keys(tables).map(table => [table, table === 'attachments' ? '1' : '0']));
  f.manifest.tableDigests = Object.fromEntries(Object.keys(tables).map(table => [table, hash('')]));
  await f.save();
  assert.deepEqual(await verifyBundle(f.root), f.manifest);
  delete f.manifest.tableCounts.page_collab_updates;
  delete f.manifest.tableDigests.page_collab_updates;
  await f.save();
  await assert.rejects(verifyBundle(f.root), /table set differs/);
});
