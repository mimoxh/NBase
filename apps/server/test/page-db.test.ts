import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';
import { PgAttachmentRepository } from '../src/attachments/repository.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:4318';
const ownerPassword = 'local integration password only';

function content(text: string) {
  return { schemaVersion: 1, editorState: { root: {
    type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, children: [
      { type: 'text', version: 1, text, style: '' },
    ] }],
  } } };
}

test('isolated PostgreSQL page path protects identity, revisions and retries', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, async () => {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  assert.equal(source.pathname, '/nbase_p2');
  const admin = new pg.Pool({ connectionString: sourceUrl, max: 2, connectionTimeoutMillis: 5000 });
  const databaseName = `nbase_p2_test_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  let pool: pg.Pool | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let attachmentRoot: string | undefined;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const url = new URL(sourceUrl);
    url.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 5000 });
    attachmentRoot = await mkdtemp(join(tmpdir(), 'nbase-attachment-test-'));
    assert.equal(await runMigrations(pool), 6);
    const owner = await initializeOwner(pool, 'owner', await hashPassword(ownerPassword), '测试空间');
    app = await buildApp({
      auth: { repository: new PgAuthRepository(pool), publicOrigin: origin },
      pages: new PgPageRepository(pool),
      attachments: new PgAttachmentRepository(pool, attachmentRoot),
    });
    const base = `/api/workspaces/${owner.workspaceId}`;
    const unauthenticated = await app.inject({ method: 'GET', url: `${base}/pages` });
    assert.equal(unauthenticated.statusCode, 401);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login',
      headers: { origin }, payload: { loginName: 'owner', password: ownerPassword } });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
    const csrfToken = login.json().csrfToken as string;
    const readHeaders = { cookie };
    const writeHeaders = { cookie, origin, 'x-csrf-token': csrfToken };
    const wrongWorkspace = await app.inject({ method: 'GET', url: `/api/workspaces/${randomUUID()}/pages`, headers: readHeaders });
    assert.equal(wrongWorkspace.statusCode, 404);

    const createMutation = randomUUID();
    const createBody = { clientMutationId: createMutation, parentId: null, title: '第一页', content: content('初稿') };
    const createdPage = await app.inject({ method: 'POST', url: `${base}/pages`, headers: writeHeaders, payload: createBody });
    assert.equal(createdPage.statusCode, 201, createdPage.body);
    const pageId = createdPage.json().id as string;
    assert.equal(createdPage.json().revision, '1');
    const retry = await app.inject({ method: 'POST', url: `${base}/pages`, headers: writeHeaders, payload: createBody });
    assert.equal(retry.statusCode, 201);
    assert.equal(retry.json().id, pageId);
    const mutatedKey = await app.inject({ method: 'POST', url: `${base}/pages`, headers: writeHeaders,
      payload: { ...createBody, title: '其他内容' } });
    assert.equal(mutatedKey.statusCode, 409);
    assert.equal(mutatedKey.json().error, 'MUTATION_CONFLICT');
    const receipt = await app.inject({ method: 'GET', url: `${base}/mutations/${createMutation}`, headers: readHeaders });
    assert.equal(receipt.statusCode, 200);
    assert.equal(receipt.json().response.id, pageId);

    const opened = await app.inject({ method: 'GET', url: `${base}/pages/${pageId}`, headers: readHeaders });
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.json().content.editorState.root.children[0].children[0].text, '初稿');
    const list = await app.inject({ method: 'GET', url: `${base}/pages?limit=1`, headers: readHeaders });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().pages[0].id, pageId);
    const noSearchSession = await app.inject({ method: 'GET', url: `${base}/search?q=${encodeURIComponent('初稿')}` });
    assert.equal(noSearchSession.statusCode, 401);
    const oldSearch = await app.inject({ method: 'GET', url: `${base}/search?q=${encodeURIComponent('初稿')}`, headers: readHeaders });
    assert.equal(oldSearch.statusCode, 200, oldSearch.body);
    assert.equal(oldSearch.json().results[0].pageId, pageId);
    assert.equal(oldSearch.json().results[0].matchField, 'content');
    const titleSearch = await app.inject({ method: 'GET', url: `${base}/search?q=${encodeURIComponent('一页')}`, headers: readHeaders });
    assert.equal(titleSearch.json().results[0].matchField, 'title');

    const updateMutation = randomUUID();
    const updateBody = { clientMutationId: updateMutation, expectedRevision: '1', content: content('修改后') };
    const updated = await app.inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: writeHeaders, payload: updateBody });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().revision, '2');
    const staleSearch = await app.inject({ method: 'GET', url: `${base}/search?q=${encodeURIComponent('初稿')}`, headers: readHeaders });
    assert.equal(staleSearch.json().results.length, 0);
    const freshSearch = await app.inject({ method: 'GET', url: `${base}/search?q=${encodeURIComponent('修改后')}`, headers: readHeaders });
    assert.equal(freshSearch.json().results[0].pageId, pageId);
    const updateRetry = await app.inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: writeHeaders, payload: updateBody });
    assert.equal(updateRetry.statusCode, 200);
    assert.equal(updateRetry.json().revision, '2');
    const stale = await app.inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '1', title: '过期更新' } });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().currentRevision, '2');
    const future = await app.inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '2', content: { ...content('不可写'), schemaVersion: 2 } } });
    assert.equal(future.statusCode, 422);
    const preserved = await app.inject({ method: 'GET', url: `${base}/pages/${pageId}`, headers: readHeaders });
    assert.equal(preserved.json().revision, '2');
    assert.equal(preserved.json().content.editorState.root.children[0].children[0].text, '修改后');

    const child = await app.inject({ method: 'POST', url: `${base}/pages`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), parentId: pageId, title: '子页', content: content('子内容') } });
    assert.equal(child.statusCode, 201, child.body);
    const cycle = await app.inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '2', parentId: child.json().id } });
    assert.equal(cycle.statusCode, 422);
    assert.equal(cycle.json().error, 'PAGE_TREE_INVALID');
    const listChild = await app.inject({ method: 'GET', url: `${base}/pages?parentId=${pageId}`, headers: readHeaders });
    assert.equal(listChild.statusCode, 200, listChild.body);
    assert.equal(listChild.json().pages[0].id, child.json().id);

    const secondRoot = await app.inject({ method: 'POST', url: `${base}/pages`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), parentId: null, title: '第二页', content: content('第二页内容') } });
    assert.equal(secondRoot.statusCode, 201, secondRoot.body);
    const mixed = await app.inject({ method: 'POST', url: `${base}/pages`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), parentId: null, title: '项目API规划',
        content: content('中文API混排 进度 50%_完成 <script>只是文本</script>') } });
    assert.equal(mixed.statusCode, 201, mixed.body);
    const mixedSearch = await app.inject({ method: 'GET', url: `${base}/search?q=${encodeURIComponent('文api混')}`,
      headers: readHeaders });
    assert.equal(mixedSearch.statusCode, 200, mixedSearch.body);
    assert.equal(mixedSearch.json().results[0].pageId, mixed.json().id);
    assert.equal(mixedSearch.json().results[0].snippet.includes('中文API混排'), true);
    const literalSearch = await app.inject({ method: 'GET', url: `${base}/search?q=${encodeURIComponent('50%_')}`,
      headers: readHeaders });
    assert.equal(literalSearch.json().results[0].pageId, mixed.json().id);
    const limitedSearch = await app.inject({ method: 'GET', url: `${base}/search?q=${encodeURIComponent('页')}&limit=1`,
      headers: readHeaders });
    assert.equal(limitedSearch.json().results.length, 1);
    assert.equal(limitedSearch.json().truncated, true);
    const wrongSearchWorkspace = await app.inject({ method: 'GET',
      url: `/api/workspaces/${randomUUID()}/search?q=${encodeURIComponent('中文')}`, headers: readHeaders });
    assert.equal(wrongSearchWorkspace.statusCode, 404);
    const firstBatch = await app.inject({ method: 'GET', url: `${base}/pages?limit=1`, headers: readHeaders });
    assert.equal(firstBatch.statusCode, 200, firstBatch.body);
    assert.equal(firstBatch.json().pages.length, 1);
    assert.ok(firstBatch.json().nextCursor);
    const nextBatch = await app.inject({ method: 'GET',
      url: `${base}/pages?limit=1&cursor=${encodeURIComponent(firstBatch.json().nextCursor)}`, headers: readHeaders });
    assert.equal(nextBatch.statusCode, 200, nextBatch.body);
    assert.equal(nextBatch.json().pages[0].id, secondRoot.json().id);

    const trashMutation = randomUUID();
    const trashBody = { clientMutationId: trashMutation, expectedRevision: '2', expectedSubtreeIds: [pageId, child.json().id] };
    const trashed = await app.inject({ method: 'POST', url: `${base}/pages/${pageId}/trash`,
      headers: writeHeaders, payload: trashBody });
    assert.equal(trashed.statusCode, 200, trashed.body);
    assert.equal(trashed.json().revision, '3');
    const trashRetry = await app.inject({ method: 'POST', url: `${base}/pages/${pageId}/trash`,
      headers: writeHeaders, payload: trashBody });
    assert.equal(trashRetry.statusCode, 200);
    assert.equal(trashRetry.json().revision, '3');
    const hiddenParent = await app.inject({ method: 'GET', url: `${base}/pages/${pageId}`, headers: readHeaders });
    const hiddenChild = await app.inject({ method: 'GET', url: `${base}/pages/${child.json().id}`, headers: readHeaders });
    assert.equal(hiddenParent.statusCode, 404);
    assert.equal(hiddenChild.statusCode, 404);
    const trashedSearch = await app.inject({ method: 'GET', url: `${base}/search?q=${encodeURIComponent('修改后')}`,
      headers: readHeaders });
    assert.equal(trashedSearch.json().results.length, 0);
    const restored = await app.inject({ method: 'POST', url: `${base}/pages/${pageId}/restore`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '3' } });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().revision, '4');
    const visibleChild = await app.inject({ method: 'GET', url: `${base}/pages/${child.json().id}`, headers: readHeaders });
    assert.equal(visibleChild.statusCode, 200);
    const restoredSearch = await app.inject({ method: 'GET', url: `${base}/search?q=${encodeURIComponent('修改后')}`,
      headers: readHeaders });
    assert.equal(restoredSearch.json().results[0].pageId, pageId);

    const history = await app.inject({ method: 'GET', url: `${base}/pages/${pageId}/history?limit=2`, headers: readHeaders });
    assert.deepEqual(history.json().versions.map((item: { revision: string }) => item.revision), ['4', '3']);
    assert.equal(history.json().nextBeforeRevision, '3');
    const olderHistory = await app.inject({ method: 'GET', url: `${base}/pages/${pageId}/history?beforeRevision=3`, headers: readHeaders });
    assert.deepEqual(olderHistory.json().versions.map((item: { revision: string }) => item.revision), ['2', '1']);
    assert.equal((await app.inject({ method: 'GET', url: `${base}/pages/${pageId}/history/1` })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: `/api/workspaces/${randomUUID()}/pages/${pageId}/history/1`, headers: readHeaders })).statusCode, 404);
    const oldVersion = await app.inject({ method: 'GET', url: `${base}/pages/${pageId}/history/1`, headers: readHeaders });
    assert.equal(oldVersion.json().content.editorState.root.children[0].children[0].text, '初稿');

    const mixedId = mixed.json().id as string;
    const beforeRestore = await app.inject({ method: 'PATCH', url: `${base}/pages/${mixedId}`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '1', title: '临时新版', content: content('恢复前内容') } });
    assert.equal(beforeRestore.statusCode, 200);
    const restoreVersionBody = { clientMutationId: randomUUID(), expectedRevision: '2', sourceRevision: '1' };
    const restoreVersion = await app.inject({ method: 'POST', url: `${base}/pages/${mixedId}/restore-version`,
      headers: writeHeaders, payload: restoreVersionBody });
    assert.equal(restoreVersion.statusCode, 200, restoreVersion.body);
    assert.equal(restoreVersion.json().revision, '3');
    assert.equal(restoreVersion.json().title, '项目API规划');
    const versionRetry = await app.inject({ method: 'POST', url: `${base}/pages/${mixedId}/restore-version`,
      headers: writeHeaders, payload: restoreVersionBody });
    assert.equal(versionRetry.json().revision, '3');
    const changedSource = await app.inject({ method: 'POST', url: `${base}/pages/${mixedId}/restore-version`,
      headers: writeHeaders, payload: { ...restoreVersionBody, sourceRevision: '2' } });
    assert.equal(changedSource.statusCode, 409);
    assert.equal(changedSource.json().error, 'MUTATION_CONFLICT');
    const retained = await app.inject({ method: 'GET', url: `${base}/pages/${mixedId}/history/2`, headers: readHeaders });
    assert.equal(retained.json().content.editorState.root.children[0].children[0].text, '恢复前内容');
    const restoreRace = await Promise.all([
      app.inject({ method: 'POST', url: `${base}/pages/${mixedId}/restore-version`, headers: writeHeaders,
        payload: { clientMutationId: randomUUID(), expectedRevision: '3', sourceRevision: '2' } }),
      app.inject({ method: 'PATCH', url: `${base}/pages/${mixedId}`, headers: writeHeaders,
        payload: { clientMutationId: randomUUID(), expectedRevision: '3', title: '并发修改' } }),
    ]);
    assert.deepEqual(restoreRace.map(item => item.statusCode).sort(), [200, 409]);
    await pool.query(`CREATE FUNCTION fail_test_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.title = 'snapshot-fail' THEN RAISE EXCEPTION 'test snapshot failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_test_snapshot BEFORE INSERT ON page_versions FOR EACH ROW EXECUTE FUNCTION fail_test_snapshot();`);
    const failedSnapshot = await app.inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '4', title: 'snapshot-fail' } });
    assert.equal(failedSnapshot.statusCode, 503);
    const afterFailedSnapshot = await app.inject({ method: 'GET', url: `${base}/pages/${pageId}`, headers: readHeaders });
    assert.equal(afterFailedSnapshot.json().revision, '4');
    assert.equal(afterFailedSnapshot.json().title, '第一页');
    await pool.query('DROP TRIGGER fail_test_snapshot ON page_versions; DROP FUNCTION fail_test_snapshot()');

    const treePage = async (parentId: string | null, title: string) => {
      const result = await app!.inject({ method: 'POST', url: `${base}/pages`, headers: writeHeaders,
        payload: { clientMutationId: randomUUID(), parentId, title, content: content(title) } });
      assert.equal(result.statusCode, 201, result.body); return result.json().id as string;
    };
    const treeRoot = await treePage(null, '删除组');
    const treeChild = await treePage(treeRoot, '选中子页');
    const treeLeaf = await treePage(treeChild, '随选中恢复');
    const treeSibling = await treePage(treeRoot, '兄弟仍删除');
    const independent = await treePage(treeRoot, '此前独立删除');
    const changedSubtree = await app.inject({ method: 'POST', url: `${base}/pages/${treeRoot}/trash`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '1', expectedSubtreeIds: [treeRoot] } });
    assert.equal(changedSubtree.statusCode, 409);
    assert.equal(changedSubtree.json().error, 'PAGE_TREE_CHANGED');
    assert.equal((await app.inject({ method: 'GET', url: `${base}/pages/${treeRoot}`, headers: readHeaders })).statusCode, 200);
    for (const id of [independent, treeRoot]) {
      assert.equal((await app.inject({ method: 'POST', url: `${base}/pages/${id}/trash`, headers: writeHeaders,
        payload: { clientMutationId: randomUUID(), expectedRevision: '1' } })).statusCode, 200);
    }
    const trashList = await app.inject({ method: 'GET', url: `${base}/trash?limit=1`, headers: readHeaders });
    assert.equal(trashList.json().pages.length, 1);
    assert.ok(trashList.json().nextCursor);
    assert.equal((await app.inject({ method: 'GET', url: `${base}/trash?limit=1&cursor=${encodeURIComponent(trashList.json().nextCursor)}`,
      headers: readHeaders })).json().pages.length, 1);
    const childRestore = await app.inject({ method: 'POST', url: `${base}/pages/${treeChild}/restore`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '2' } });
    assert.equal(childRestore.statusCode, 200, childRestore.body);
    assert.equal(childRestore.json().parentId, null);
    assert.equal((await app.inject({ method: 'GET', url: `${base}/pages/${treeLeaf}`, headers: readHeaders })).json().parentId, treeChild);
    assert.equal((await app.inject({ method: 'GET', url: `${base}/pages/${treeSibling}`, headers: readHeaders })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/pages/${treeRoot}/restore`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '2' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `${base}/pages/${treeSibling}`, headers: readHeaders })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `${base}/trash/${independent}`, headers: readHeaders })).statusCode, 200);

    await pool.query('UPDATE workspace_memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, owner.userId, 'viewer']);
    const viewerRead = await app.inject({ method: 'GET', url: `${base}/pages/${pageId}`, headers: readHeaders });
    assert.equal(viewerRead.statusCode, 200);
    const viewerSearch = await app.inject({ method: 'GET', url: `${base}/search?q=${encodeURIComponent('修改后')}`,
      headers: readHeaders });
    assert.equal(viewerSearch.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `${base}/pages/${pageId}/history/1`, headers: readHeaders })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `${base}/trash`, headers: readHeaders })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `${base}/pages/${pageId}/restore-version`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '4', sourceRevision: '1' } })).statusCode, 403);
    const viewerWrite = await app.inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '4', title: '不应写入' } });
    assert.equal(viewerWrite.statusCode, 403);
    await pool.query('UPDATE workspace_memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, owner.userId, 'owner']);

    const concurrentCreateBody = {
      clientMutationId: randomUUID(), parentId: null, title: '并发重试', content: content('同一操作'),
    };
    const concurrentCreates = await Promise.all([1, 2].map(() => app!.inject({
      method: 'POST', url: `${base}/pages`, headers: writeHeaders, payload: concurrentCreateBody,
    })));
    assert.deepEqual(concurrentCreates.map(response => response.statusCode), [201, 201]);
    assert.equal(concurrentCreates[0]!.json().id, concurrentCreates[1]!.json().id);
    const racePageId = concurrentCreates[0]!.json().id as string;
    const concurrentUpdates = await Promise.all(['甲', '乙'].map(value => app!.inject({
      method: 'PATCH', url: `${base}/pages/${racePageId}`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '1', content: content(value) },
    })));
    assert.deepEqual(concurrentUpdates.map(response => response.statusCode).sort(), [200, 409]);
    const raceFinal = await app.inject({ method: 'GET', url: `${base}/pages/${racePageId}`, headers: readHeaders });
    assert.equal(raceFinal.statusCode, 200);
    assert.equal(raceFinal.json().revision, '2');

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/LZ0AAAAASUVORK5CYII=', 'base64');
    const attachmentId = randomUUID();
    const uploadUrl = `${base}/attachments/${attachmentId}?name=${encodeURIComponent('插图.png')}`;
    const uploadHeaders = { ...writeHeaders, 'content-type': 'application/octet-stream' };
    const unauthenticatedUpload = await app.inject({ method: 'PUT', url: uploadUrl,
      headers: { origin, 'content-type': 'application/octet-stream' }, payload: png });
    assert.equal(unauthenticatedUpload.statusCode, 401);
    const wrongOriginUpload = await app.inject({ method: 'PUT', url: uploadUrl,
      headers: { ...uploadHeaders, origin: 'http://elsewhere.test' }, payload: png });
    assert.equal(wrongOriginUpload.statusCode, 403);
    const upload = await app.inject({ method: 'PUT', url: uploadUrl, headers: uploadHeaders, payload: png });
    assert.equal(upload.statusCode, 201, upload.body);
    assert.equal(upload.json().id, attachmentId);
    assert.equal(upload.json().mediaType, 'image/png');
    const repeatedUpload = await app.inject({ method: 'PUT', url: uploadUrl, headers: uploadHeaders, payload: png });
    assert.equal(repeatedUpload.statusCode, 200);
    assert.equal(repeatedUpload.json().sha256, upload.json().sha256);
    const concurrentAttachmentId = randomUUID();
    const concurrentUploads = await Promise.all([1, 2].map(() => app!.inject({ method: 'PUT',
      url: `${base}/attachments/${concurrentAttachmentId}?name=parallel.png`, headers: uploadHeaders, payload: png })));
    assert.deepEqual(concurrentUploads.map(response => response.statusCode).sort(), [200, 201]);
    assert.equal(concurrentUploads[0]!.json().id, concurrentUploads[1]!.json().id);
    const interruptedId = randomUUID();
    const listener = await app.listen({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => {
      const request = httpRequest(new URL(`${base}/attachments/${interruptedId}?name=partial.png`, listener), {
        method: 'PUT', headers: { ...uploadHeaders, 'content-length': String(png.length + 100) },
      });
      request.on('error', () => resolve());
      request.on('close', () => resolve());
      request.write(png.subarray(0, 12));
      setTimeout(() => request.destroy(), 20);
    });
    const interruptedMetadata = await app.inject({ method: 'GET',
      url: `${base}/attachments/${interruptedId}`, headers: readHeaders });
    assert.equal(interruptedMetadata.statusCode, 404);
    const resumedUpload = await app.inject({ method: 'PUT',
      url: `${base}/attachments/${interruptedId}?name=partial.png`, headers: uploadHeaders, payload: png });
    assert.equal(resumedUpload.statusCode, 201, resumedUpload.body);
    const changedUpload = await app.inject({ method: 'PUT', url: uploadUrl, headers: uploadHeaders,
      payload: Buffer.concat([png, Buffer.from('changed')]) });
    assert.equal(changedUpload.statusCode, 409);
    const traversal = await app.inject({ method: 'PUT',
      url: `${base}/attachments/${randomUUID()}?name=${encodeURIComponent('../escape.png')}`,
      headers: uploadHeaders, payload: png });
    assert.equal(traversal.statusCode, 400);
    const spoofed = await app.inject({ method: 'PUT',
      url: `${base}/attachments/${randomUUID()}?name=fake.png`, headers: uploadHeaders,
      payload: Buffer.from('<svg onload="alert(1)"/>') });
    assert.equal(spoofed.statusCode, 415);
    const tooLarge = await app.inject({ method: 'PUT',
      url: `${base}/attachments/${randomUUID()}?name=large.png`, headers: uploadHeaders,
      payload: Buffer.alloc(10 * 1024 * 1024 + 1) });
    assert.equal(tooLarge.statusCode, 413);
    const noAccess = await app.inject({ method: 'GET', url: `${base}/attachments/${attachmentId}/content` });
    assert.equal(noAccess.statusCode, 401);
    const crossWorkspace = await app.inject({ method: 'GET',
      url: `/api/workspaces/${randomUUID()}/attachments/${attachmentId}/content`, headers: readHeaders });
    assert.equal(crossWorkspace.statusCode, 404);
    const contentGet = await app.inject({ method: 'GET', url: `${base}/attachments/${attachmentId}/content`, headers: readHeaders });
    assert.equal(contentGet.statusCode, 200);
    assert.equal(contentGet.headers['content-type'], 'image/png');
    assert.equal(contentGet.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(contentGet.rawPayload, png);
    const textId = randomUUID();
    const textBytes = Buffer.from('# 本机附件\n这是测试文件。\n');
    const textUpload = await app.inject({ method: 'PUT',
      url: `${base}/attachments/${textId}?name=${encodeURIComponent('说明.md')}`,
      headers: uploadHeaders, payload: textBytes });
    assert.equal(textUpload.statusCode, 201, textUpload.body);
    assert.equal(textUpload.json().mediaType, 'text/markdown');
    const textGet = await app.inject({ method: 'GET', url: `${base}/attachments/${textId}/content`, headers: readHeaders });
    assert.equal(textGet.statusCode, 200);
    assert.equal(textGet.headers['content-type'], 'application/octet-stream');
    assert.match(String(textGet.headers['content-disposition']), /^attachment;/);
    assert.deepEqual(textGet.rawPayload, textBytes);
    await pool.query('UPDATE workspace_memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, owner.userId, 'viewer']);
    const viewerAttachment = await app.inject({ method: 'GET', url: `${base}/attachments/${textId}/content`, headers: readHeaders });
    assert.equal(viewerAttachment.statusCode, 200);
    const viewerAttachmentUpload = await app.inject({ method: 'PUT',
      url: `${base}/attachments/${randomUUID()}?name=viewer.md`, headers: uploadHeaders, payload: textBytes });
    assert.equal(viewerAttachmentUpload.statusCode, 403);
    await pool.query('UPDATE workspace_memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, owner.userId, 'owner']);

    const attachmentContent = { schemaVersion: 1, editorState: { root: {
      type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, children: [{
        type: 'attachment', version: 1, attachmentId, alt: '插图', fileName: '插图.png', mediaType: 'image/png',
      }] }],
    } } };
    const attachedPage = await app.inject({ method: 'POST', url: `${base}/pages`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), parentId: null, title: '有图片', content: attachmentContent } });
    assert.equal(attachedPage.statusCode, 201, attachedPage.body);
    const attachmentPageId = attachedPage.json().id as string;
    assert.equal((await app.inject({ method: 'PATCH', url: `${base}/pages/${attachmentPageId}`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '1', content: content('暂时移除图片') } })).statusCode, 200);
    const oldAttachmentRestore = await app.inject({ method: 'POST', url: `${base}/pages/${attachmentPageId}/restore-version`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '2', sourceRevision: '1' } });
    assert.equal(oldAttachmentRestore.statusCode, 200, oldAttachmentRestore.body);
    assert.equal(oldAttachmentRestore.json().content.editorState.root.children[0].children[0].attachmentId, attachmentId);
    const invalidReference = await app.inject({ method: 'POST', url: `${base}/pages`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), parentId: null, title: '无效图片', content: {
        ...attachmentContent, editorState: { root: { ...attachmentContent.editorState.root,
          children: [{ type: 'paragraph', version: 1, children: [{ type: 'attachment', version: 1,
            attachmentId: randomUUID(), alt: '丢失', fileName: '插图.png', mediaType: 'image/png' }] }],
        } },
      } } });
    assert.equal(invalidReference.statusCode, 422);
    assert.equal(invalidReference.json().error, 'ATTACHMENT_INVALID');
    const trashWithAttachment = await app.inject({ method: 'POST', url: `${base}/pages/${attachedPage.json().id}/trash`,
      headers: writeHeaders, payload: { clientMutationId: randomUUID(), expectedRevision: '3' } });
    assert.equal(trashWithAttachment.statusCode, 200);
    const stillAvailable = await app.inject({ method: 'GET', url: `${base}/attachments/${attachmentId}/content`, headers: readHeaders });
    assert.equal(stillAvailable.statusCode, 200);
    await unlink(join(attachmentRoot, `${owner.workspaceId}-${attachmentId}`));
    const missingFile = await app.inject({ method: 'GET', url: `${base}/attachments/${attachmentId}/content`, headers: readHeaders });
    assert.equal(missingFile.statusCode, 503);
    assert.equal(missingFile.json().error, 'ATTACHMENT_MISSING');

    await app.close();
    app = await buildApp({ auth: { repository: new PgAuthRepository(pool), publicOrigin: origin },
      pages: new PgPageRepository(pool), attachments: new PgAttachmentRepository(pool, attachmentRoot) });
    const reopened = await app.inject({ method: 'GET', url: `${base}/pages/${pageId}`, headers: readHeaders });
    assert.equal(reopened.statusCode, 200);
    assert.equal(reopened.json().revision, '4');
    assert.equal(reopened.json().content.editorState.root.children[0].children[0].text, '修改后');
  } finally {
    if (app) await app.close();
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
    if (attachmentRoot && dirname(attachmentRoot) === tmpdir() && basename(attachmentRoot).startsWith('nbase-attachment-test-')) {
      await rm(attachmentRoot, { recursive: true, force: true });
    }
  }
});

test('page-tree returns the reachable subtree in created order with bounded results', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, async () => {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  assert.equal(source.pathname, '/nbase_p2');
  const admin = new pg.Pool({ connectionString: sourceUrl, max: 2, connectionTimeoutMillis: 5000 });
  const databaseName = `nbase_p2_test_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  let pool: pg.Pool | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let attachmentRoot: string | undefined;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const url = new URL(sourceUrl);
    url.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 5000 });
    attachmentRoot = await mkdtemp(join(tmpdir(), 'nbase-attachment-test-'));
    assert.equal(await runMigrations(pool), 6);
    const owner = await initializeOwner(pool, 'owner', await hashPassword(ownerPassword), '测试空间');
    const pages = new PgPageRepository(pool);
    app = await buildApp({
      auth: { repository: new PgAuthRepository(pool), publicOrigin: origin },
      pages, attachments: new PgAttachmentRepository(pool, attachmentRoot),
    });
    const base = `/api/workspaces/${owner.workspaceId}`;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login',
      headers: { origin }, payload: { loginName: 'owner', password: ownerPassword } });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
    const csrfToken = login.json().csrfToken as string;
    const readHeaders = { cookie };
    const writeHeaders = { cookie, origin, 'x-csrf-token': csrfToken };

    const unauthenticated = await app.inject({ method: 'GET', url: `${base}/page-tree` });
    assert.equal(unauthenticated.statusCode, 401);
    const wrongWorkspaceList = await app.inject({ method: 'GET', url: `/api/workspaces/${randomUUID()}/pages`, headers: readHeaders });
    const wrongWorkspace = await app.inject({ method: 'GET', url: `/api/workspaces/${randomUUID()}/page-tree`, headers: readHeaders });
    assert.equal(wrongWorkspace.statusCode, wrongWorkspaceList.statusCode);

    const create = async (parentId: string | null, title: string) => {
      const response = await app!.inject({ method: 'POST', url: `${base}/pages`, headers: writeHeaders,
        payload: { clientMutationId: randomUUID(), parentId, title, content: content(title) } });
      assert.equal(response.statusCode, 201, response.body);
      return response.json().id as string;
    };
    const rootId = await create(null, '根页面');
    const childId = await create(rootId, '子页面');
    const grandchildId = await create(childId, '孙页面');
    const trashRootId = await create(null, '待删根页面');
    const trashChildId = await create(trashRootId, '待删子页面');

    const first = await app.inject({ method: 'GET', url: `${base}/page-tree`, headers: readHeaders });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().truncated, false);
    assert.deepEqual(first.json().pages.map((page: { id: string }) => page.id),
      [rootId, childId, grandchildId, trashRootId, trashChildId]);

    const trashed = await app.inject({ method: 'POST', url: `${base}/pages/${trashRootId}/trash`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '1' } });
    assert.equal(trashed.statusCode, 200, trashed.body);
    const after = await app.inject({ method: 'GET', url: `${base}/page-tree`, headers: readHeaders });
    assert.equal(after.statusCode, 200, after.body);
    assert.equal(after.json().truncated, false);
    assert.deepEqual(after.json().pages.map((page: { id: string }) => page.id), [rootId, childId, grandchildId]);

    const limited = await pages.tree(owner.workspaceId, owner.userId, 2);
    assert.equal(limited.truncated, true);
    assert.deepEqual(limited.pages.map(page => page.id), [rootId, childId]);
  } finally {
    if (app) await app.close();
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
    if (attachmentRoot && dirname(attachmentRoot) === tmpdir() && basename(attachmentRoot).startsWith('nbase-attachment-test-')) {
      await rm(attachmentRoot, { recursive: true, force: true });
    }
  }
});

test('page appearance and favorites survive revisions, search, trash and restore', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, async () => {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  assert.equal(source.pathname, '/nbase_p2');
  const admin = new pg.Pool({ connectionString: sourceUrl, max: 2, connectionTimeoutMillis: 5000 });
  const databaseName = `nbase_p2_test_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  let pool: pg.Pool | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let attachmentRoot: string | undefined;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const url = new URL(sourceUrl);
    url.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 5000 });
    attachmentRoot = await mkdtemp(join(tmpdir(), 'nbase-attachment-test-'));
    assert.equal(await runMigrations(pool), 6);
    const owner = await initializeOwner(pool, 'owner', await hashPassword(ownerPassword), '测试空间');
    app = await buildApp({
      auth: { repository: new PgAuthRepository(pool), publicOrigin: origin },
      pages: new PgPageRepository(pool),
      attachments: new PgAttachmentRepository(pool, attachmentRoot),
    });
    const base = `/api/workspaces/${owner.workspaceId}`;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login',
      headers: { origin }, payload: { loginName: 'owner', password: ownerPassword } });
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
    const csrfToken = login.json().csrfToken as string;
    const readHeaders = { cookie };
    const writeHeaders = { cookie, origin, 'x-csrf-token': csrfToken };

    // create with icon/cover; invalid values → 400 INVALID_REQUEST
    const createdPage = await app.inject({ method: 'POST', url: `${base}/pages`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), parentId: null, title: '手册', icon: '🐘', cover: 'slate', content: content('备份') } });
    assert.equal(createdPage.statusCode, 201, createdPage.body);
    const pageId = createdPage.json().id as string;
    assert.equal(createdPage.json().icon, '🐘');
    assert.equal(createdPage.json().cover, 'slate');
    for (const bad of [{ icon: 'AB' }, { icon: 'A' }, { icon: '📄📄' }, { cover: 'beige' }, { cover: 'https://x' }]) {
      const rejected: { statusCode: number; json(): { error?: string } } = await app.inject(
        { method: 'POST', url: `${base}/pages`, headers: writeHeaders,
          payload: { clientMutationId: randomUUID(), parentId: null, title: 'x', ...bad, content: content('x') } });
      assert.equal(rejected.statusCode, 400, JSON.stringify(bad));
      assert.equal(rejected.json().error, 'INVALID_REQUEST');
    }

    // icon-only update is a normal revisioned update with a snapshot
    const iconOnly = await app.inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '1', icon: '📘' } });
    assert.equal(iconOnly.statusCode, 200, iconOnly.body);
    assert.equal(iconOnly.json().revision, '2');
    assert.equal(iconOnly.json().icon, '📘');
    assert.equal(iconOnly.json().cover, 'slate');
    const v2 = await app.inject({ method: 'GET', url: `${base}/pages/${pageId}/history/2`, headers: readHeaders });
    assert.equal(v2.statusCode, 200);
    assert.equal(v2.json().icon, '📘');
    assert.equal(v2.json().cover, 'slate');
    const removed = await app.inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '2', icon: null, cover: null } });
    assert.equal(removed.json().icon, null);
    assert.equal(removed.json().cover, null);

    // restore-version keeps the CURRENT appearance (restores title/body only)
    const restyled = await app.inject({ method: 'PATCH', url: `${base}/pages/${pageId}`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '3', icon: '🧪', cover: 'rose', title: '手册 v4' } });
    assert.equal(restyled.json().revision, '4');
    const rv = await app.inject({ method: 'POST', url: `${base}/pages/${pageId}/restore-version`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: '4', sourceRevision: '1' } });
    assert.equal(rv.statusCode, 200, rv.body);
    assert.equal(rv.json().icon, '🧪');
    assert.equal(rv.json().cover, 'rose');
    assert.equal(rv.json().title, '手册');

    // appearance flows through tree, trash summaries and search
    const tree = await app.inject({ method: 'GET', url: `${base}/page-tree`, headers: readHeaders });
    assert.equal(tree.json().pages.find((p: { id: string }) => p.id === pageId).icon, '🧪');
    const search = await app.inject({ method: 'GET', url: `${base}/search?q=${encodeURIComponent('手册')}`, headers: readHeaders });
    assert.equal(search.json().results[0].icon, '🧪');
    const cur = await app.inject({ method: 'GET', url: `${base}/pages/${pageId}`, headers: readHeaders });
    const trashed = await app.inject({ method: 'POST', url: `${base}/pages/${pageId}/trash`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: cur.json().revision } });
    assert.equal(trashed.statusCode, 200);
    const trashList = await app.inject({ method: 'GET', url: `${base}/trash`, headers: readHeaders });
    const trashRow = trashList.json().pages.find((p: { id: string }) => p.id === pageId);
    assert.equal(trashRow.icon, '🧪');
    assert.equal(trashRow.cover, 'rose');

    // favorites: PUT idempotent, GET lists active pages, trashed page 404 + hidden until restore
    const fav404 = await app.inject({ method: 'PUT', url: `${base}/favorites/${pageId}`, headers: writeHeaders, payload: {} });
    assert.equal(fav404.statusCode, 404, 'trashed page is not favorite-able');
    const badId = await app.inject({ method: 'PUT', url: `${base}/favorites/not-a-uuid`, headers: writeHeaders, payload: {} });
    assert.equal(badId.statusCode, 404);
    const ghost = await app.inject({ method: 'PUT', url: `${base}/favorites/${randomUUID()}`, headers: writeHeaders, payload: {} });
    assert.equal(ghost.statusCode, 404);
    const restored = await app.inject({ method: 'POST', url: `${base}/pages/${pageId}/restore`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: trashed.json().revision } });
    assert.equal(restored.statusCode, 200, restored.body);
    const fav1 = await app.inject({ method: 'PUT', url: `${base}/favorites/${pageId}`, headers: writeHeaders, payload: {} });
    assert.equal(fav1.statusCode, 204, fav1.body);
    const fav2 = await app.inject({ method: 'PUT', url: `${base}/favorites/${pageId}`, headers: writeHeaders, payload: {} });
    assert.equal(fav2.statusCode, 204);
    let list = await app.inject({ method: 'GET', url: `${base}/favorites`, headers: readHeaders });
    assert.deepEqual(list.json().pageIds, [pageId]);
    // write path requires Origin + CSRF
    const noOrigin = await app.inject({ method: 'PUT', url: `${base}/favorites/${pageId}`, headers: { cookie }, payload: {} });
    assert.equal(noOrigin.statusCode, 403);
    const noCsrf = await app.inject({ method: 'DELETE', url: `${base}/favorites/${pageId}`, headers: { cookie, origin }, payload: {} });
    assert.equal(noCsrf.statusCode, 403);
    // trashed favorite is hidden by GET but survives; visible again after restore
    const afterRestore = await app.inject({ method: 'GET', url: `${base}/pages/${pageId}`, headers: readHeaders });
    const trashed2 = await app.inject({ method: 'POST', url: `${base}/pages/${pageId}/trash`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: afterRestore.json().revision } });
    assert.equal(trashed2.statusCode, 200);
    list = await app.inject({ method: 'GET', url: `${base}/favorites`, headers: readHeaders });
    assert.deepEqual(list.json().pageIds, []);
    const restored2 = await app.inject({ method: 'POST', url: `${base}/pages/${pageId}/restore`, headers: writeHeaders,
      payload: { clientMutationId: randomUUID(), expectedRevision: trashed2.json().revision } });
    assert.equal(restored2.statusCode, 200);
    list = await app.inject({ method: 'GET', url: `${base}/favorites`, headers: readHeaders });
    assert.deepEqual(list.json().pageIds, [pageId]);
    // DELETE is idempotent
    const del = await app.inject({ method: 'DELETE', url: `${base}/favorites/${pageId}`, headers: writeHeaders, payload: {} });
    assert.equal(del.statusCode, 204);
    const delAgain = await app.inject({ method: 'DELETE', url: `${base}/favorites/${pageId}`, headers: writeHeaders, payload: {} });
    assert.equal(delAgain.statusCode, 204);
    list = await app.inject({ method: 'GET', url: `${base}/favorites`, headers: readHeaders });
    assert.deepEqual(list.json().pageIds, []);
    // limit: 201st favorite → 409 FAVORITE_LIMIT (seed rows directly, one tx per PUT)
    const extraIds: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const c = await app.inject({ method: 'POST', url: `${base}/pages`, headers: writeHeaders,
        payload: { clientMutationId: randomUUID(), parentId: null, title: `f${i}`, content: content('x') } });
      extraIds.push(c.json().id);
    }
    await pool.query(`INSERT INTO page_favorites (workspace_id, user_id, page_id)
      SELECT $1, $2, unnest($3::uuid[])`, [owner.workspaceId, owner.userId, extraIds]);
    const over = await app.inject({ method: 'PUT', url: `${base}/favorites/${pageId}`, headers: writeHeaders, payload: {} });
    assert.equal(over.statusCode, 409);
    assert.equal(over.json().error, 'FAVORITE_LIMIT');
    // cross-workspace isolation: a second user's session never sees these favorites
    const other = await app.inject({ method: 'GET', url: `/api/workspaces/${randomUUID()}/favorites`, headers: readHeaders });
    assert.equal(other.statusCode, 404);
    const unauth = await app.inject({ method: 'GET', url: `${base}/favorites` });
    assert.equal(unauth.statusCode, 401);
  } finally {
    if (app) await app.close();
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
    if (attachmentRoot && dirname(attachmentRoot) === tmpdir() && basename(attachmentRoot).startsWith('nbase-attachment-test-')) {
      await rm(attachmentRoot, { recursive: true, force: true });
    }
  }
});
