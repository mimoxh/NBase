// Generates local configuration only; does not start Docker or overwrite credentials.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access, readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  project: { type: 'string', default: 'nbase' }, port: { type: 'string', default: '3000' },
  'env-file': { type: 'string', default: '.env.docker' },
  // For configurations made before CalDAV: adds only the credential key, and touches nothing else.
  'add-credential-key': { type: 'boolean', default: false },
} });
if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(values.project)) throw new Error('Invalid Compose project name');
if (!/^\.env\.[a-z0-9.-]+$/.test(values['env-file']) || values['env-file'].endsWith('.example')) throw new Error('Use a local .env.* filename');
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024-65535');
const root = fileURLToPath(new URL('../', import.meta.url));
const secretRoot = join(root, '.secrets');
const secretDir = join(secretRoot, values.project);
const envPath = join(root, values['env-file']);
const keySource = `./.secrets/${values.project}/credential-key`;
// 32 random bytes, base64 on one line: the AES-256 key that seals stored CalDAV credentials. It is not in backups.
const credentialKey = () => randomBytes(32).toString('base64') + '\n';

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

if (values['add-credential-key']) {
  if (!await exists(envPath) || !await exists(secretDir)) throw new Error('No existing configuration for this project; run without --add-credential-key');
  const keyPath = join(secretDir, 'credential-key');
  const env = await readFile(envPath, 'utf8');
  const hasLine = /^NBASE_CREDENTIAL_KEY_SOURCE=/m.test(env);
  if (await exists(keyPath)) {
    if (hasLine) { process.stdout.write('The credential key is already configured; nothing was changed.\n'); process.exit(0); }
  } else {
    await writeFile(keyPath, credentialKey(), { flag: 'wx', mode: 0o644 });
  }
  if (!hasLine) await appendFile(envPath, `${env.endsWith('\n') || env === '' ? '' : '\n'}NBASE_CREDENTIAL_KEY_SOURCE=${keySource}\n`, { mode: 0o600 });
  process.stdout.write(`Added .secrets/${values.project}/credential-key and NBASE_CREDENTIAL_KEY_SOURCE. The key was not printed.\n`);
  process.exit(0);
}

for (const path of [envPath, secretDir]) {
  if (await exists(path)) throw new Error('Configuration or secret directory already exists; nothing was overwritten');
}
await mkdir(secretRoot, { recursive: true, mode: 0o700 });
await mkdir(secretDir, { mode: 0o700 });
// Private host directory; files must be readable by the non-root container user.
for (const name of ['db-password', 'owner-password']) {
  await writeFile(join(secretDir, name), randomBytes(32).toString('base64url') + '\n', { flag: 'wx', mode: 0o644 });
}
await writeFile(join(secretDir, 'credential-key'), credentialKey(), { flag: 'wx', mode: 0o644 });
await writeFile(envPath, [
  `NBASE_COMPOSE_PROJECT=${values.project}`, `NBASE_IMAGE_TAG=${values.project}`, `NBASE_PORT=${port}`,
  `NBASE_PUBLIC_ORIGIN=http://127.0.0.1:${port}`,
  `NBASE_DB_PASSWORD_SOURCE=./.secrets/${values.project}/db-password`,
  `NBASE_OWNER_PASSWORD_SOURCE=./.secrets/${values.project}/owner-password`,
  `NBASE_CREDENTIAL_KEY_SOURCE=${keySource}`,
  'NBASE_OWNER_LOGIN=owner', '',
].join('\n'), { flag: 'wx', mode: 0o600 });
process.stdout.write(`Created ${values['env-file']} and .secrets/${values.project}/. Passwords and keys were not printed.\n`);
