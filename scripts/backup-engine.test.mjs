import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyBundle, copyVerified } from './backup-engine.mjs';
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
    'pages', 'page_versions', 'page_mutation_receipts', 'attachments'];
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
