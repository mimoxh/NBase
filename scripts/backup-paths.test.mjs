import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prospectivePath, within, assertOutsideDataVolumes } from './backup-paths.mjs';

test('database and attachment roots reject identical/nested output but allow sibling prefixes', () => {
  const database = resolve('data/postgres'), attachments = resolve('data/attachments');
  for (const path of [database, join(database, 'backup/new'), attachments, join(attachments, 'backup/new')]) {
    assert.throws(() => assertOutsideDataVolumes(path, [database, attachments]), /outside/);
  }
  assertOutsideDataVolumes(resolve('data/postgres-backup'), [database, attachments]);
  assert.equal(within(database, resolve('data/postgres-backup')), false);
});

test('new output under a symlink resolves to the real data volume before directory creation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nbase-backup-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = join(root, 'postgres');
  await mkdir(database);
  const alias = join(root, 'alias');
  try { await symlink(database, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('OS symlink privilege unavailable'); return; } throw error; }
  const destination = await prospectivePath(join(alias, 'new/backup'));
  assert.equal(destination, join(await prospectivePath(database), 'new/backup'));
  assert.throws(() => assertOutsideDataVolumes(destination, [database]), /outside/);
});
