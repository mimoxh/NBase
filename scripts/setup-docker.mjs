// Generates local configuration only; does not start Docker or overwrite credentials.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  project: { type: 'string', default: 'nbase' }, port: { type: 'string', default: '3000' },
  'env-file': { type: 'string', default: '.env.docker' },
} });
if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(values.project)) throw new Error('Invalid Compose project name');
if (!/^\.env\.[a-z0-9.-]+$/.test(values['env-file']) || values['env-file'].endsWith('.example')) throw new Error('Use a local .env.* filename');
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024-65535');
const root = fileURLToPath(new URL('../', import.meta.url));
const secretRoot = join(root, '.secrets');
const secretDir = join(secretRoot, values.project);
const envPath = join(root, values['env-file']);
for (const path of [envPath, secretDir]) {
  try { await access(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  throw new Error('Configuration or secret directory already exists; nothing was overwritten');
}
await mkdir(secretRoot, { recursive: true, mode: 0o700 });
await mkdir(secretDir, { mode: 0o700 });
// Private host directory; files must be readable by the non-root container user.
for (const name of ['db-password', 'owner-password']) {
  await writeFile(join(secretDir, name), randomBytes(32).toString('base64url') + '\n', { flag: 'wx', mode: 0o644 });
}
await writeFile(envPath, [
  `NBASE_COMPOSE_PROJECT=${values.project}`, `NBASE_IMAGE_TAG=${values.project}`, `NBASE_PORT=${port}`,
  `NBASE_PUBLIC_ORIGIN=http://127.0.0.1:${port}`,
  `NBASE_DB_PASSWORD_SOURCE=./.secrets/${values.project}/db-password`,
  `NBASE_OWNER_PASSWORD_SOURCE=./.secrets/${values.project}/owner-password`,
  'NBASE_OWNER_LOGIN=owner', '',
].join('\n'), { flag: 'wx', mode: 0o600 });
process.stdout.write(`Created ${values['env-file']} and .secrets/${values.project}/. Passwords were not printed.\n`);
