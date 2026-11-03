// Host-side maintenance window controller. Secrets are mounted, never passed in argv.
import { spawn } from 'node:child_process';
import { mkdir, realpath, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { prospectivePath, within, assertOutsideDataVolumes } from './backup-paths.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string', default: '.env.docker' }, directory: { type: 'string' },
  image: { type: 'string', default: 'nbase-maintenance:local' },
} });
const action = positionals[0];
if (positionals.length !== 1 || !['backup', 'verify', 'restore'].includes(action) || !values.directory) {
  throw new Error('Usage: node -- scripts/backup.mjs <backup|verify|restore> --config .env.docker --directory PATH [--image IMAGE]');
}
async function docker(args, capture = false) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('docker', args, { cwd: root, shell: false, windowsHide: true,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout?.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveResult(stdout.trim()) : reject(new Error(`Docker failed (${code}): ${stderr.slice(-5000)}`)));
  });
}
const compose = ['compose', '-f', join(root, 'compose.yaml'), '--env-file', resolve(root, values.config)];
const directory = resolve(values.directory);
if (directory.includes(',')) throw new Error('Backup path cannot contain a comma (Docker mount syntax)');
const canonicalDirectory = action === 'backup' ? await prospectivePath(directory) : await realpath(directory);
const toolImage = JSON.parse(await docker(['image', 'inspect', values.image], true))[0];
async function inspect(id) { return JSON.parse(await docker(['inspect', id], true))[0]; }
async function restartOriginal(appId, imageId) {
  const original = await inspect(appId);
  if (original.Image !== imageId) throw new Error('Source container changed; restart it manually after checking its image');
  await docker(['start', appId], true);
  const deadline = Date.now() + 65000;
  while (Date.now() < deadline) {
    const state = (await inspect(appId)).State;
    if (state.Running && state.Health?.Status === 'healthy') return;
    if (!state.Running) throw new Error('Original source container stopped during restart');
    await new Promise(resolveResult => setTimeout(resolveResult, 1000));
  }
  throw new Error('Original source container did not become healthy; check its logs');
}
if (action === 'verify') {
  await docker(['run', '--rm', '--network', 'none', '--read-only', '--mount', `type=bind,src=${canonicalDirectory},dst=/backup,readonly`,
    '-e', 'NBASE_BACKUP_DIR=/backup', toolImage.Id, 'verify']);
} else {
  const config = JSON.parse(await docker([...compose, 'config', '--format', 'json'], true));
  const project = config.name;
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw new Error('Invalid Compose project name');
  const sourceFile = config.secrets?.db_password?.file;
  if (!sourceFile || !config.services?.nbase || !config.services?.postgres) throw new Error('Expected the NBase Compose deployment');
  const secret = await realpath(sourceFile);
  if (secret.includes(',')) throw new Error('Secret path cannot contain a comma');
  // The destination must never be placed inside the secret directory.
  if (within(dirname(secret), canonicalDirectory) || within(join(root, '.secrets'), canonicalDirectory)) {
    throw new Error('Use a backup directory outside the secret directory');
  }
  let appId = await docker([...compose, 'ps', '-a', '-q', 'nbase'], true);
  if (appId.includes('\n')) throw new Error('Only a single application container is supported');
  let app = appId ? JSON.parse(await docker(['inspect', appId], true))[0] : undefined;
  if (action === 'backup' && !app) throw new Error('Source application container is missing');
  if (action === 'restore' && app?.State.Running) throw new Error('Restore target application must be stopped; existing data is never overwritten');
  if (action === 'backup') {
    const sourceMount = app.Mounts.find(item => item.Destination === '/data/attachments');
    const storageId = await docker([...compose, 'ps', '-q', 'postgres'], true);
    if (!storageId) throw new Error('PostgreSQL must be running');
    const storage = await inspect(storageId);
    const dataSources = [sourceMount?.Source, ...storage.Mounts.map(mount => mount.Source)].filter(Boolean).map(source => resolve(source));
    assertOutsideDataVolumes(canonicalDirectory, dataSources);
    await mkdir(canonicalDirectory, { recursive: true, mode: 0o700 });
    if ((await readdir(canonicalDirectory)).length) throw new Error('Backup destination must be empty');
  }
  const wasRunning = action === 'backup' && app.State.Running;
  const originalImage = app?.Image;
  // Docker daemon-wide lock also covers separate checkouts using the same project.
  const lockName = `nbase-maintenance-lock-${project}`;
  const lockId = await docker(['create', '--name', lockName, '--network', 'none',
    '--label', `nbase.maintenance.project=${project}`, '--entrypoint', '/bin/true', toolImage.Id], true)
    .catch(() => { throw new Error(`Maintenance lock exists or could not be created: ${lockName}. Inspect it and ensure no operation is running before removing a stale lock.`); });
  try {
    if (wasRunning) await docker(['stop', '-t', '60', appId], true);
    if (action === 'restore') {
      // Validate the entire bundle before creating target storage.
      await docker(['run', '--rm', '--network', 'none', '--read-only', '--mount', `type=bind,src=${canonicalDirectory},dst=/backup,readonly`,
        '-e', 'NBASE_BACKUP_DIR=/backup', toolImage.Id, 'verify']);
      await docker([...compose, 'up', '-d', '--wait', 'postgres']);
      if (!app) {
        await docker([...compose, 'create', 'nbase']);
        appId = await docker([...compose, 'ps', '-a', '-q', 'nbase'], true);
        app = JSON.parse(await docker(['inspect', appId], true))[0];
      }
    }
    const attachmentMount = app.Mounts.find(item => item.Destination === '/data/attachments');
    if (attachmentMount?.Type !== 'volume') throw new Error('This controller requires the NBase named attachment volume');
    const pgId = await docker([...compose, 'ps', '-q', 'postgres'], true);
    if (!pgId) throw new Error('PostgreSQL must be running');
    const postgres = JSON.parse(await docker(['inspect', pgId], true))[0];
    const currentApp = await inspect(appId);
    if (currentApp.State.Running || currentApp.Image !== app.Image) throw new Error('Application changed during maintenance');
    const configured = Object.fromEntries(app.Config.Env.map(entry => { const index = entry.indexOf('='); return [entry.slice(0,index),entry.slice(index+1)]; }));
    if (configured.NBASE_DATABASE_HOST !== 'postgres' || configured.NBASE_DATABASE_NAME !== 'nbase' || configured.NBASE_DATABASE_USER !== 'nbase'
      || configured.NBASE_DATABASE_PASSWORD_FILE !== '/run/secrets/db_password' || configured.NBASE_DATABASE_URL) {
      throw new Error('Container database configuration differs from the supported Compose deployment');
    }
    const networks = Object.keys(postgres.NetworkSettings.Networks);
    const network = networks.find(name => Object.hasOwn(app.NetworkSettings.Networks, name));
    if (!network) throw new Error('Application and PostgreSQL must share a Compose network');
    const running = (await docker(['ps', '-q'], true)).split(/\s+/).filter(Boolean);
    if (running.length) {
      const containers = JSON.parse(await docker(['inspect', ...running], true));
      if (containers.some(container => container.Mounts.some(mount => mount.Name === attachmentMount.Name && mount.RW))) {
        throw new Error('Another running container can write the attachment volume; stop it before maintenance');
      }
    }
    await docker(['run', '--rm', '--read-only', '--network', network,
      '--mount', `type=volume,src=${attachmentMount.Name},dst=/data/attachments${action === 'backup' ? ',readonly' : ''}`,
      '--mount', `type=bind,src=${canonicalDirectory},dst=/backup${action === 'restore' ? ',readonly' : ''}`,
      '--mount', `type=bind,src=${secret},dst=/run/secrets/db_password,readonly`,
      '-e', 'NBASE_DATABASE_HOST=postgres', '-e', 'NBASE_DATABASE_NAME=nbase', '-e', 'NBASE_DATABASE_USER=nbase',
      '-e', 'NBASE_DATABASE_PASSWORD_FILE=/run/secrets/db_password', '-e', 'NBASE_BACKUP_DIR=/backup',
      '-e', 'NBASE_ATTACHMENT_DIR=/data/attachments', '-e', `NBASE_BACKUP_APP_IMAGE_ID=${app.Image}`,
      '-e', `NBASE_BACKUP_POSTGRES_IMAGE_ID=${postgres.Image}`, toolImage.Id, action]);
    console.log(`${action} complete: ${canonicalDirectory}`);
    if (action === 'restore') console.log('Target application remains stopped. Verify the result before starting it.');
  } finally {
    try { if (wasRunning) await restartOriginal(appId, originalImage); }
    finally { await docker(['rm', lockId], true); }
  }
}
