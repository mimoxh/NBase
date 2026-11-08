// Disposable large-database benchmark. It only runs against the local test PostgreSQL and drops its own database.
// Usage: NBASE_TEST_DATABASE_URL=... node --import tsx test/database-bench.ts [rows]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { DatabaseDocument, PropertyDefinition } from '@nbase/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { PgAuthRepository } from '../src/auth/repository.js';
import { runMigrations } from '../src/db/migrate.js';
import { PgPageRepository } from '../src/pages/repository.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
assert.ok(sourceUrl, 'Set NBASE_TEST_DATABASE_URL');
const source = new URL(sourceUrl);
assert.equal(source.hostname, '127.0.0.1');
assert.equal(source.port, '54329');
assert.equal(source.pathname, '/nbase_p2');
const rowCount = Number(process.argv[2] ?? 25000);
const origin = 'http://127.0.0.1:4318';
const ownerPassword = 'local benchmark password only';
const emptyContent = { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [] } } };

const admin = new pg.Pool({ connectionString: sourceUrl, max: 2 });
const databaseName = `nbase_p2_bench_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE DATABASE "${databaseName}"`);
const url = new URL(sourceUrl);
url.pathname = `/${databaseName}`;
const pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  await runMigrations(pool);
  const owner = await initializeOwner(pool, 'owner', await hashPassword(ownerPassword), '基准空间');
  app = await buildApp({ auth: { repository: new PgAuthRepository(pool), publicOrigin: origin },
    pages: new PgPageRepository(pool), notesPool: pool });
  const instance = app;
  const base = `/api/workspaces/${owner.workspaceId}`;
  const login = await instance.inject({ method: 'POST', url: '/api/auth/login', headers: { origin },
    payload: { loginName: 'owner', password: ownerPassword } });
  const cookie = String(login.headers['set-cookie']).split(';', 1)[0]!;
  const read = { cookie };
  const write = { cookie, origin, 'x-csrf-token': login.json().csrfToken as string };

  const created = await instance.inject({ method: 'POST', url: `${base}/databases`, headers: write,
    payload: { clientMutationId: randomUUID(), parentId: null, title: '基准表' } });
  assert.equal(created.statusCode, 201, created.body);
  const db = created.json() as DatabaseDocument;
  const options = ['待办', '进行中', '完成', '搁置'].map((name, i) => ({ id: randomUUID(), name, color: i % 2 ? 'blue' as const : 'green' as const }));
  const fields = {
    text: { id: randomUUID(), name: '备注', type: 'text' }, number: { id: randomUUID(), name: '金额', type: 'number' },
    select: { id: randomUUID(), name: '状态', type: 'select', options }, date: { id: randomUUID(), name: '日期', type: 'date' },
    done: { id: randomUUID(), name: '完成', type: 'checkbox' },
  } satisfies Record<string, PropertyDefinition>;
  const properties: PropertyDefinition[] = [...db.properties, ...Object.values(fields)];
  const schema = await instance.inject({ method: 'PATCH', url: `${base}/databases/${db.page.id}`, headers: write,
    payload: { clientMutationId: randomUUID(), expectedRevision: db.schemaRevision, properties, views: db.views } });
  assert.equal(schema.statusCode, 200, schema.body);
  let schemaRevision = schema.json().schemaRevision as string;
  const template = await instance.inject({ method: 'POST', url: `${base}/pages`, headers: write,
    payload: { clientMutationId: randomUUID(), parentId: db.page.id, title: '模板', content: emptyContent, properties: {} } });
  assert.equal(template.statusCode, 201, template.body);

  // Clones the template row with generated values; every other column is copied as is.
  const columns = (await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'pages' AND is_generated = 'NEVER'`)).rows.map(row => row.column_name)
    .filter(name => !['id', 'title', 'row_properties', 'search_text', 'sort_position'].includes(name));
  const list = columns.map(name => `"${name}"`).join(', ');
  const seedStart = performance.now();
  await pool.query(`INSERT INTO pages (id, title, row_properties, search_text, sort_position, ${list})
    SELECT gen_random_uuid(), '记录 ' || n,
      jsonb_strip_nulls(jsonb_build_object($2::text, '备注内容 ' || n, $3::text, (n % 9973) * 1.5, $4::text, ($5::text[])[1 + n % 4],
        $6::text, to_char(date '2020-01-01' + (n % 2000), 'YYYY-MM-DD'), $7::text, CASE WHEN n % 3 = 0 THEN true END)),
      '备注内容 ' || n, n * 1024, ${list}
    FROM pages t, generate_series(1, $8::int) n WHERE t.id = $1`,
  [template.json().id, fields.text.id, fields.number.id, fields.select.id, options.map(o => o.id), fields.date.id, fields.done.id, rowCount - 1]);
  await pool.query('ANALYZE pages');
  console.log(`seeded ${rowCount} rows in ${Math.round(performance.now() - seedStart)} ms`);

  // A document write that has to wait for the workspace lock shows how long a heavy operation blocks everyone else.
  const probeWrite = async () => {
    const started = performance.now();
    const response = await instance.inject({ method: 'POST', url: `${base}/pages`, headers: write,
      payload: { clientMutationId: randomUUID(), parentId: null, title: 'probe', content: emptyContent } });
    assert.equal(response.statusCode, 201, response.body);
    return Math.round(performance.now() - started);
  };
  const report: Record<string, { ms: number; blockedWriteMs: number; status: number }> = {};
  const measure = async (name: string, operation: () => Promise<LightMyRequestResponse>) => {
    const started = performance.now();
    const running = operation();
    await new Promise(resolve => setTimeout(resolve, 20));
    const blocked = probeWrite();
    const response = await running;
    const ms = Math.round(performance.now() - started);
    report[name] = { ms, blockedWriteMs: await blocked, status: response.statusCode };
    return response;
  };

  report.idleWrite = { ms: await probeWrite(), blockedWriteMs: 0, status: 201 };
  await measure('readDatabase', () => instance.inject({ method: 'GET', url: `${base}/databases/${db.page.id}`, headers: read }));
  const query = (filters: unknown[], sorts: unknown[]) => instance.inject({ method: 'POST', url: `${base}/databases/${db.page.id}/query`, headers: write,
    payload: { filters, sorts, context: { timeZone: 'Asia/Shanghai' } } });
  await measure('queryAll', () => query([], []));
  await measure('querySortText', () => query([], [{ propertyId: fields.text.id, direction: 'asc' }]));
  await measure('querySortNumber', () => query([], [{ propertyId: fields.number.id, direction: 'desc' }]));
  await measure('queryFilterSort', () => query([{ propertyId: fields.select.id, operator: 'equals', value: options[1]!.id },
    { propertyId: fields.text.id, operator: 'contains', value: '99' }], [{ propertyId: fields.date.id, direction: 'desc' }]));
  await measure('queryOrFilter', () => query([{ any: [{ propertyId: fields.number.id, operator: 'gt', value: 5000 },
    { propertyId: fields.done.id, operator: 'is_checked' }] }], [{ propertyId: fields.select.id, direction: 'asc' }]));
  const recolored = properties.map(p => p.id === fields.select.id
    ? { ...p, options: options.map((o, i) => i === 0 ? { ...o, color: 'red' as const } : o) } : p);
  const recolor = await measure('recolorOption', () => instance.inject({ method: 'PATCH', url: `${base}/databases/${db.page.id}`, headers: write,
    payload: { clientMutationId: randomUUID(), expectedRevision: schemaRevision, properties: recolored, views: db.views } }));
  assert.equal(recolor.statusCode, 200, recolor.body);
  schemaRevision = recolor.json().schemaRevision;
  const ids = (await pool.query<{ id: string }>(`SELECT id FROM pages WHERE parent_id = $1 AND deleted_at IS NULL
    ORDER BY sort_position, id`, [db.page.id])).rows.map(row => row.id);
  const middle = ids[Math.floor(ids.length / 2)]!;
  const target = ids[Math.floor(ids.length / 4)]!;
  await measure('moveRow', () => instance.inject({ method: 'PUT', url: `${base}/pages/${middle}/position`, headers: write,
    payload: { afterPageId: target } }));
  const trashed = await measure('trashDatabase', () => instance.inject({ method: 'POST', url: `${base}/pages/${db.page.id}/trash`, headers: write,
    payload: { clientMutationId: randomUUID(), expectedRevision: db.page.revision } }));
  assert.equal(trashed.statusCode, 200, trashed.body);
  const restored = await measure('restoreDatabase', () => instance.inject({ method: 'POST', url: `${base}/pages/${db.page.id}/restore`, headers: write,
    payload: { clientMutationId: randomUUID(), expectedRevision: trashed.json().revision } }));
  assert.equal(restored.statusCode, 200, restored.body);
  // A paced import into a fresh database, with a document save racing every chunk.
  const importTarget = (await instance.inject({ method: 'POST', url: `${base}/databases`, headers: write,
    payload: { clientMutationId: randomUUID(), parentId: null, title: '导入表' } })).json() as DatabaseDocument;
  const chunk = 500;
  const importStart = performance.now();
  const chunkTimes: number[] = [];
  const probeTimes: number[] = [];
  for (let start = 0; start < rowCount; start += chunk) {
    const rows = Array.from({ length: Math.min(chunk, rowCount - start) }, (_, offset) => ({ title: `导入 ${start + offset}`, properties: {} }));
    const started = performance.now();
    const running = instance.inject({ method: 'POST', url: `${base}/databases/${importTarget.page.id}/rows/bulk`, headers: write,
      payload: { clientMutationId: randomUUID(), operation: 'create', rows } });
    const probing = probeWrite();
    const response = await running;
    assert.equal(response.statusCode, 200, response.body);
    chunkTimes.push(performance.now() - started);
    probeTimes.push(await probing);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const percentile = (values: number[], p: number) => Math.round([...values].sort((a, b) => a - b)[Math.floor(values.length * p)]!);
  console.table(report);
  console.log(`import ${rowCount} rows in ${Math.round(performance.now() - importStart)} ms; chunk p50 ${percentile(chunkTimes, 0.5)} p95 ${percentile(chunkTimes, 0.95)}; save during import p50 ${percentile(probeTimes, 0.5)} p95 ${percentile(probeTimes, 0.95)} max ${percentile(probeTimes, 0.999)}`);
} finally {
  await app?.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  await admin.end();
}
