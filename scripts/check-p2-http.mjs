import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = process.env.NBASE_PUBLIC_ORIGIN;
const passwordFile = process.env.NBASE_OWNER_PASSWORD_FILE;
if (!base || !passwordFile) throw new Error('NBASE_PUBLIC_ORIGIN and NBASE_OWNER_PASSWORD_FILE are required');
const origin = new URL(base);
if (origin.hostname !== '127.0.0.1' || origin.port !== '4317') {
  throw new Error('This check runs only against the local P2 workbench on port 4317');
}
const password = (await readFile(passwordFile, 'utf8')).trim();
const json = (text) => ({ schemaVersion: 1, editorState: { root: {
  type: 'root', version: 1, children: [{ type: 'paragraph', version: 1,
    children: [{ type: 'text', version: 1, text, style: '' }] }],
} } });

async function call(path, options = {}) {
  const response = await fetch(new URL(path, base), { cache: 'no-store', ...options });
  return { response, body: response.status === 204 ? null : await response.json() };
}

const login = await call('/api/auth/login', {
  method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
  body: JSON.stringify({ loginName: 'owner', password }),
});
assert.equal(login.response.status, 200, JSON.stringify(login.body));
const cookie = login.response.headers.get('set-cookie')?.split(';', 1)[0];
assert.ok(cookie);
const workspaceId = login.body.workspaces[0]?.id;
assert.ok(workspaceId);
const csrf = login.body.csrfToken;
const readHeaders = { Cookie: cookie };
const writeHeaders = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
const title = `P2 实机验收 ${new Date().toISOString().slice(0, 16)}`;
const pagePath = `/api/workspaces/${workspaceId}/pages`;
const created = await call(pagePath, {
  method: 'POST', headers: writeHeaders,
  body: JSON.stringify({ clientMutationId: randomUUID(), parentId: null, title, content: json('真实 HTTP 初稿') }),
});
assert.equal(created.response.status, 201, JSON.stringify(created.body));
const pageId = created.body.id;
const updated = await call(`${pagePath}/${pageId}`, {
  method: 'PATCH', headers: writeHeaders,
  body: JSON.stringify({ clientMutationId: randomUUID(), expectedRevision: created.body.revision,
    content: json('真实 HTTP 修改并重开') }),
});
assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
assert.equal(updated.body.revision, '2');
const reopened = await call(`${pagePath}/${pageId}`, { headers: readHeaders });
assert.equal(reopened.response.status, 200);
assert.equal(reopened.body.content.editorState.root.children[0].children[0].text, '真实 HTTP 修改并重开');
const logout = await call('/api/auth/logout', {
  method: 'POST', headers: writeHeaders, body: '{}',
});
assert.equal(logout.response.status, 204);
const afterLogout = await call(`${pagePath}/${pageId}`, { headers: readHeaders });
assert.equal(afterLogout.response.status, 401);
process.stdout.write(`Local HTTP page create/update/reopen/logout passed: ${pageId}\n`);
