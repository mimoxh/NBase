// Read-only HTTP comparison of a source workspace and new disposable recovery instances.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const capture = process.argv[2] === 'capture';
const configFile = capture ? '.env.p3.deploy' : process.argv[2];
assert.match(configFile ?? '', /^\.env\.p3\.(deploy|restore|rollback|upgrade)[a-z0-9.-]*$/);
const config = parseEnv(await readFile(join(root, configFile), 'utf8'));
assert.match(config.NBASE_COMPOSE_PROJECT, /^nbase-p3-(deploy|restore|rollback|upgrade)-[0-9-]+$/);
const origin = config.NBASE_PUBLIC_ORIGIN;
assert.match(origin, /^http:\/\/127\.0\.0\.1:432[5-9]$/);
const password = (await readFile(join(root, '.secrets/nbase-p3-deploy-20261030/owner-password'), 'utf8')).trimEnd();
const baselinePath = join(root, '.data/p3-recovery-baseline.json');
async function request(path, { session, body, status = 200 } = {}) {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(10000),
    headers: { origin, ...(session ? { cookie: session.cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(response.status, status, `${path}: expected ${status}, received ${response.status}`);
  return response;
}
await request('/api/ready');
const baseline = capture ? undefined : JSON.parse(await readFile(baselinePath, 'utf8'));
if (baseline) await request('/api/auth/session', { session: baseline.oldSession, status: 401 });
const login = await request('/api/auth/login', { body: { loginName: 'owner', password } });
const identity = await login.json();
const session = { cookie: login.headers.get('set-cookie').split(';', 1)[0] };
const data = { user: identity.user, workspaces: identity.workspaces, pages: [], trash: [], attachments: [] };
const attachments = new Map();
function collect(value, workspaceId) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'attachment') attachments.set(`${workspaceId}/${value.attachmentId}`, { workspaceId, id: value.attachmentId });
  for (const item of Object.values(value)) if (typeof item === 'object') collect(item, workspaceId);
}
for (const workspace of identity.workspaces) {
  const base = `/api/workspaces/${workspace.id}`;
  const queue = [null], active = [], trashed = [];
  while (queue.length) {
    const parent = queue.shift();
    let cursor = null;
    do {
      const query = new URLSearchParams({ limit: '100', ...(parent ? { parentId: parent } : {}), ...(cursor ? { cursor } : {}) });
      const list = await (await request(`${base}/pages?${query}`, { session })).json();
      for (const item of list.pages) { active.push(item.id); queue.push(item.id); }
      cursor = list.nextCursor;
    } while (cursor);
  }
  let cursor = null;
  do {
    const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
    const list = await (await request(`${base}/trash?${query}`, { session })).json();
    trashed.push(...list.pages.map(item => item.id));
    cursor = list.nextCursor;
  } while (cursor);
  for (const [ids, isTrash] of [[active, false], [trashed, true]]) {
    for (const id of ids.sort()) {
      const document = await (await request(`${base}/${isTrash ? 'trash' : 'pages'}/${id}`, { session })).json();
      const history = [];
      let before = null;
      do {
        const query = new URLSearchParams({ limit: '100', ...(before ? { beforeRevision: before } : {}) });
        const list = await (await request(`${base}/pages/${id}/history?${query}`, { session })).json();
        for (const summary of list.versions) history.push(await (await request(`${base}/pages/${id}/history/${summary.revision}`, { session })).json());
        before = list.nextBeforeRevision;
      } while (before);
      collect(document, workspace.id); collect(history, workspace.id);
      data[isTrash ? 'trash' : 'pages'].push({ document, history });
    }
  }
  const search = await (await request(`${base}/search?q=${encodeURIComponent('中文')}`, { session })).json();
  workspace.search = search;
}
for (const item of [...attachments.values()].sort((a,b) => a.id.localeCompare(b.id))) {
  const path = `/api/workspaces/${item.workspaceId}/attachments/${item.id}`;
  const metadata = await (await request(path, { session })).json();
  const bytes = Buffer.from(await (await request(path + '/content', { session })).arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256);
  assert.equal(bytes.length, metadata.byteSize);
  await request(path + '/content', { status: 401 });
  data.attachments.push(metadata);
}
if (capture) {
  await writeFile(baselinePath, JSON.stringify({ data, oldSession: session }), { mode: 0o600 });
  console.log(`Captured current source: ${data.pages.length} pages, ${data.trash.length} trash entries, ${data.attachments.length} referenced attachments.`);
} else {
  assert.deepEqual(data, baseline.data);
  console.log('Recovery passed: login, old session invalidation, all current pages/versions, hierarchy, trash, search and referenced attachment hashes/authorization.');
}
