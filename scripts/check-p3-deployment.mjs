// Disposable P3 deployment acceptance only. Never point this at a personal/production instance.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = Object.fromEntries((await readFile(join(root, '.env.p3.deploy'), 'utf8')).trim().split(/\r?\n/).map(line => line.split('=')));
const project = config.NBASE_COMPOSE_PROJECT;
assert.match(project, /^nbase-p3-deploy-\d{8}$/);
const origin = 'http://127.0.0.1:4325';
assert.equal(config.NBASE_PUBLIC_ORIGIN, origin);
assert.equal(config.NBASE_OWNER_PASSWORD_SOURCE, `./.secrets/${project}/owner-password`);
const ownerPath = join(root, '.secrets', project, 'owner-password');
const previousPasswordPath = join(root, '.secrets', project, 'previous-owner-password');
const statePath = join(root, '.data', `${project}-acceptance.json`);
const password = (await readFile(ownerPath, 'utf8')).trimEnd();
const mode = process.argv[2];
assert.ok(['seed', 'verify', 'expect-revoked', 'rotate-password-file', 'expect-reset', 'expect-storage-down'].includes(mode));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/LZ0AAAAASUVORK5CYII=', 'base64');

async function request(path, { method = 'GET', session, body, bytes, status = 200 } = {}) {
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(10000),
    headers: { origin, ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}),
      ...(body ? { 'content-type': 'application/json' } : bytes ? { 'content-type': 'application/octet-stream' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : bytes ? { body: bytes } : {}),
  });
  assert.equal(response.status, status, `${method} ${path}: expected ${status}, received ${response.status}`);
  return response;
}
async function login(secret = password, status = 200) {
  const response = await request('/api/auth/login', { method: 'POST', status, body: { loginName: 'owner', password: secret } });
  if (status !== 200) return;
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';', 1)[0], csrfToken: body.csrfToken,
    workspaceId: body.workspaces[0].id };
}
function content(text, attachmentId) {
  return { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [
    { type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text, style: '' }] },
    ...(attachmentId ? [{ type: 'paragraph', version: 1, children: [{ type: 'attachment', version: 1,
      attachmentId, alt: '持久卷插图', fileName: 'docker-fixture.png', mediaType: 'image/png' }] }] : []),
  ] } } };
}
if (mode === 'expect-storage-down') {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  await request('/api/health');
  await request('/api/ready', { status: 503 });
  await request('/api/auth/session', { session: state.session, status: 503 });
  await request(`/api/workspaces/${state.session.workspaceId}/pages`, { session: state.session, status: 503 });
  console.log('Database outage: liveness 200, readiness/session/page API 503; no false saved response.');
} else if (mode === 'rotate-password-file') {
  await writeFile(previousPasswordPath, password, { flag: 'wx', mode: 0o600 });
  await writeFile(ownerPath, randomBytes(32).toString('base64url') + '\n');
  console.log('Disposable owner password file rotated; database password unchanged.');
} else if (mode === 'seed') {
  try { await readFile(statePath); throw new Error('Acceptance state already exists; use verify'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await request('/api/ready');
  const session = await login();
  const base = `/api/workspaces/${session.workspaceId}`;
  assert.equal((await (await request(`${base}/pages`, { session })).json()).pages.length, 0);
  const attachmentId = randomUUID();
  await request(`${base}/attachments/${attachmentId}?name=docker-fixture.png`, { session, method: 'PUT', bytes: png, status: 201 });
  const create = async (title, parentId, text) => (await request(`${base}/pages`, { session, method: 'POST', status: 201,
    body: { clientMutationId: randomUUID(), title, parentId, content: content(text, parentId === null ? attachmentId : undefined) } })).json();
  const parent = await create('Docker 持久卷验收', null, '容器重建前的中文正文。');
  const child = await create('保留子页', parent.id, '子页面关系保持不变。');
  const trashed = await create('回收站验收页', parent.id, '删除后仍保留正文。');
  await request(`${base}/pages/${parent.id}`, { session, method: 'PATCH', body: {
    clientMutationId: randomUUID(), expectedRevision: '1', content: content('容器重建后仍应保留的中文正文。', attachmentId),
  } });
  await request(`${base}/pages/${trashed.id}/trash`, { session, method: 'POST', body: {
    clientMutationId: randomUUID(), expectedRevision: '1', expectedSubtreeIds: [trashed.id],
  } });
  await mkdir(join(root, '.data'), { recursive: true, mode: 0o700 });
  await writeFile(statePath, JSON.stringify({ session, parentId: parent.id, childId: child.id, trashId: trashed.id,
    attachmentId, sha256: createHash('sha256').update(png).digest('hex') }), { flag: 'wx', mode: 0o600 });
  console.log('Seeded disposable pages, child relationship, history, trash and attachment.');
} else {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  if (mode === 'expect-revoked' || mode === 'expect-reset') {
    await request('/api/auth/session', { session: state.session, status: 401 });
    await request(`/api/workspaces/${state.session.workspaceId}/pages`, { session: state.session, status: 401 });
    if (mode === 'expect-reset') await login(await readFile(previousPasswordPath, 'utf8'), 401);
    state.session = await login();
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  }
  const session = state.session;
  await request('/api/ready');
  await request('/api/auth/session', { session });
  const base = `/api/workspaces/${session.workspaceId}`;
  const parent = await (await request(`${base}/pages/${state.parentId}`, { session })).json();
  assert.equal(parent.revision, '2');
  assert.deepEqual(parent.content, content('容器重建后仍应保留的中文正文。', state.attachmentId));
  assert.equal((await (await request(`${base}/pages/${state.childId}`, { session })).json()).parentId, parent.id);
  const history = await (await request(`${base}/pages/${parent.id}/history`, { session })).json();
  assert.deepEqual(history.versions.map(item => item.revision), ['2', '1']);
  const old = await (await request(`${base}/pages/${parent.id}/history/1`, { session })).json();
  assert.deepEqual(old.content, content('容器重建前的中文正文。', state.attachmentId));
  const trash = await (await request(`${base}/trash/${state.trashId}`, { session })).json();
  assert.equal(trash.revision, '2');
  assert.equal(trash.parentId, parent.id);
  const search = await (await request(`${base}/search?q=${encodeURIComponent('中文正文')}`, { session })).json();
  assert.equal(search.results[0].pageId, parent.id);
  const bytes = Buffer.from(await (await request(`${base}/attachments/${state.attachmentId}/content`, { session })).arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), state.sha256);
  await request(`${base}/attachments/${state.attachmentId}/content`, { status: 401 });
  console.log(`${mode}: IDs, content, hierarchy, revisions, history, trash, search, attachment hash and authorization passed.`);
}
