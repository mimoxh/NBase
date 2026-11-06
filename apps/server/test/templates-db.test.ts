import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import type { NoteTemplate, PageDocument, TemplatePreview } from '@nbase/contracts';
import { buildApp } from '../src/app.js';
import { PgAttachmentRepository } from '../src/attachments/repository.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { registerTemplateRoutes } from '../src/notes/templates.js';
import { PgPageRepository } from '../src/pages/repository.js';
import { extractSearchText } from '../src/pages/search-text.js';
import { attachmentReferences } from '../src/pages/validate.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const password = 'isolated template integration password';
const text = (value: string) => ({ type: 'text', version: 1, text: value });
const content = (...children: object[]) => ({
  schemaVersion: 1, editorState: { root: {
    type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, children }],
  } },
});

test('isolated PostgreSQL keeps templates private and retries copy without creating another page', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, async () => {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  assert.equal(source.pathname, '/nbase_p2');
  const admin = new pg.Pool({ connectionString: sourceUrl, max: 1, connectionTimeoutMillis: 5000 });
  const databaseName = 'nbase_p2_test_' + randomUUID().replaceAll('-', '');
  let created = false;
  let pool: pg.Pool | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let attachmentRoot: string | undefined;
  try {
    await admin.query('CREATE DATABASE "' + databaseName + '"');
    created = true;
    const url = new URL(sourceUrl);
    url.pathname = '/' + databaseName;
    const db = new pg.Pool({ connectionString: url.toString(), max: 5, connectionTimeoutMillis: 5000 });
    pool = db;
    await runMigrations(db);
    const passwordHash = await hashPassword(password);
    const owner = await initializeOwner(db, 'owner', passwordHash, '模板测试空间');
    const editorId = randomUUID();
    await db.query('INSERT INTO users (id, login_name, password_hash) VALUES ($1, $2, $3)', [editorId, 'other-editor', passwordHash]);
    await db.query("INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'editor')",
      [owner.workspaceId, editorId]);
    const candidate = resolve(await mkdtemp(join(tmpdir(), 'nbase-template-test-')));
    assert.equal(dirname(candidate), resolve(tmpdir()));
    assert.match(basename(candidate), /^nbase-template-test-[a-zA-Z0-9]+$/);
    attachmentRoot = candidate;
    const auth = new PgAuthRepository(db);
    const pages = new PgPageRepository(db);
    const server = await buildApp({ auth: { repository: auth, publicOrigin: origin }, pages,
      attachments: new PgAttachmentRepository(db, attachmentRoot) });
    app = server;
    registerTemplateRoutes(server, db, pages, auth, origin);
    const base = '/api/workspaces/' + owner.workspaceId;
    const templates = base + '/templates';
    async function login(loginName: string) {
      const response = await server.inject({ method: 'POST', url: '/api/auth/login', headers: { origin },
        payload: { loginName, password } });
      assert.equal(response.statusCode, 200, response.body);
      return {
        cookie: String(response.headers['set-cookie']).split(';', 1)[0]!,
        origin, 'x-csrf-token': response.json<{ csrfToken: string }>().csrfToken,
      };
    }
    const headers = await login('owner');
    const other = await login('other-editor');
    assert.equal((await server.inject({ method: 'GET', url: templates })).statusCode, 401);
    const list = await server.inject({ method: 'GET', url: templates, headers });
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(list.json<NoteTemplate[]>().map(template => template.id), ['reading', 'meeting', 'troubleshooting']);
    const invalidDate = await server.inject({ method: 'POST', url: templates + '/preview', headers,
      payload: { templateId: 'reading', title: '闰日', date: '2026-02-29' } });
    assert.equal(invalidDate.statusCode, 400);

    const attachmentId = randomUUID();
    const fileName = 'template.txt';
    const upload = await server.inject({ method: 'PUT', url: base + '/attachments/' + attachmentId + '?name=' + fileName,
      headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from('模板内容') });
    assert.equal(upload.statusCode, 201, upload.body);
    const sourceContent = content(text('{{title}} / {{date}} / {{unknown}}'), {
      type: 'attachment', version: 1, attachmentId, fileName, alt: '测试附件', mediaType: 'text/plain',
    });
    const savedBody = { clientMutationId: randomUUID(), name: '  我的模板  ', content: sourceContent };
    const saved = await server.inject({ method: 'POST', url: templates, headers, payload: savedBody });
    assert.equal(saved.statusCode, 201, saved.body);
    const template = saved.json<NoteTemplate>();
    assert.equal(template.name, '我的模板');
    assert.equal(template.revision, '1');
    const saveRetry = await server.inject({ method: 'POST', url: templates, headers, payload: savedBody });
    assert.deepEqual(saveRetry.json(), template);
    const privateList = await server.inject({ method: 'GET', url: templates, headers: other });
    assert.equal(privateList.json<NoteTemplate[]>().some(item => item.id === template.id), false);
    const previewBody = { templateId: template.id, title: '中文页面', date: '2028-02-29' };
    const privatePreview = await server.inject({ method: 'POST', url: templates + '/preview', headers: other, payload: previewBody });
    assert.equal(privatePreview.statusCode, 404);
    const preview = await server.inject({ method: 'POST', url: templates + '/preview', headers, payload: previewBody });
    assert.equal(preview.statusCode, 200, preview.body);
    const rendered = preview.json<TemplatePreview>();
    assert.deepEqual(rendered.missingAttachments, []);
    assert.match(extractSearchText(rendered.content), /中文页面 \/ 2028-02-29 \/ \{\{unknown\}\}/);
    assert.equal(attachmentReferences(rendered.content)[0]!.id, attachmentId);

    const createdPage = await server.inject({ method: 'POST', url: base + '/pages', headers,
      payload: { clientMutationId: randomUUID(), title: '中文页面', parentId: null, content: rendered.content, icon: '📄', cover: 'sage' } });
    assert.equal(createdPage.statusCode, 201, createdPage.body);
    const page = createdPage.json<PageDocument>();
    const copyUrl = base + '/pages/' + page.id + '/copy';
    const copyBody = { clientMutationId: randomUUID(), sourceRevision: page.revision, title: '', parentId: null };
    const [copied, duplicate] = await Promise.all([
      server.inject({ method: 'POST', url: copyUrl, headers, payload: copyBody }),
      server.inject({ method: 'POST', url: copyUrl, headers, payload: copyBody }),
    ]);
    assert.equal(copied.statusCode, 201, copied.body);
    assert.equal(duplicate.statusCode, 201, duplicate.body);
    const copiedPage = copied.json<PageDocument>();
    assert.equal(copiedPage.id, duplicate.json<PageDocument>().id);
    assert.notEqual(copiedPage.id, page.id);
    assert.equal(copiedPage.title, '中文页面（副本）');
    assert.equal(copiedPage.revision, '1');
    assert.equal(copiedPage.icon, page.icon);
    assert.equal(copiedPage.cover, page.cover);
    assert.deepEqual(copiedPage.content, page.content);
    const file = await server.inject({ method: 'GET', url: base + '/attachments/' + attachmentId + '/content', headers });
    assert.equal(file.statusCode, 200, file.body);
    assert.equal(file.body, '模板内容');
    const badParent = await server.inject({ method: 'POST', url: copyUrl, headers,
      payload: { ...copyBody, clientMutationId: randomUUID(), parentId: randomUUID() } });
    assert.equal(badParent.statusCode, 422);
    await db.query("UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2", [owner.workspaceId, editorId]);
    const viewer = await server.inject({ method: 'POST', url: copyUrl, headers: other, payload: copyBody });
    assert.equal(viewer.statusCode, 403);
    const changed = await server.inject({ method: 'PATCH', url: base + '/pages/' + page.id, headers,
      payload: { clientMutationId: randomUUID(), expectedRevision: page.revision, title: '修改原页' } });
    assert.equal(changed.statusCode, 200, changed.body);
    const stale = await server.inject({ method: 'POST', url: copyUrl, headers,
      payload: { ...copyBody, clientMutationId: randomUUID() } });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json<{ currentRevision: string }>().currentRevision, '2');
    const trashed = await server.inject({ method: 'POST', url: base + '/pages/' + page.id + '/trash', headers,
      payload: { clientMutationId: randomUUID(), expectedRevision: '2' } });
    assert.equal(trashed.statusCode, 200, trashed.body);
    const deletedCopy = await server.inject({ method: 'POST', url: copyUrl, headers,
      payload: { ...copyBody, clientMutationId: randomUUID(), sourceRevision: '3' } });
    assert.equal(deletedCopy.statusCode, 404);

    // Simulate a reference from an older snapshot whose attachment record has been lost.
    await db.query('DELETE FROM attachments WHERE workspace_id = $1 AND id = $2', [owner.workspaceId, attachmentId]);
    const missing = await server.inject({ method: 'POST', url: templates + '/preview', headers, payload: previewBody });
    assert.equal(missing.statusCode, 200, missing.body);
    assert.deepEqual(missing.json<TemplatePreview>().missingAttachments, [fileName]);
    assert.deepEqual(attachmentReferences(missing.json<TemplatePreview>().content), []);
    assert.match(extractSearchText(missing.json<TemplatePreview>().content), /附件不可用：template\.txt/);
    const templateUrl = templates + '/' + template.id;
    const update = await server.inject({ method: 'PATCH', url: templateUrl, headers,
      payload: { clientMutationId: randomUUID(), expectedRevision: '1', name: '已更新', content: content(text('新模板')) } });
    assert.equal(update.statusCode, 200, update.body);
    assert.equal(update.json<NoteTemplate>().revision, '2');
    const untouched = await server.inject({ method: 'GET', url: base + '/pages/' + copiedPage.id, headers });
    assert.deepEqual(untouched.json<PageDocument>().content, copiedPage.content);
    const removed = await server.inject({ method: 'DELETE', url: templateUrl, headers,
      payload: { clientMutationId: randomUUID(), expectedRevision: '2' } });
    assert.equal(removed.statusCode, 200, removed.body);
  } finally {
    await app?.close();
    await pool?.end();
    if (attachmentRoot) await rm(attachmentRoot, { recursive: true, force: true });
    if (created) await admin.query('DROP DATABASE "' + databaseName + '"');
    await admin.end();
  }
});
