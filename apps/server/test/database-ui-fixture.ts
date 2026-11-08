// Recreates a disposable database for walking through large tables in a browser. Local test PostgreSQL only.
// Usage: NBASE_TEST_DATABASE_URL=... node --import tsx test/database-ui-fixture.ts [rows]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PropertyDefinition } from '@nbase/contracts';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { runMigrations } from '../src/db/migrate.js';

export const fixturePassword = 'local ui fixture password only';
const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;
assert.ok(sourceUrl, 'Set NBASE_TEST_DATABASE_URL');
const source = new URL(sourceUrl);
assert.equal(source.hostname, '127.0.0.1');
assert.equal(source.port, '54329');
assert.equal(source.pathname, '/nbase_p2');
const rowCount = Number(process.argv[2] ?? 25000);
const name = 'nbase_p2_ui_fixture';

const admin = new pg.Pool({ connectionString: sourceUrl, max: 2 });
await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
await admin.query(`CREATE DATABASE "${name}"`);
await admin.end();
const url = new URL(sourceUrl);
url.pathname = `/${name}`;
const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
try {
  await runMigrations(pool);
  const owner = await initializeOwner(pool, 'owner', await hashPassword(fixturePassword), '测试空间');
  const databaseId = randomUUID();
  const options = ['待办', '进行中', '完成', '搁置'].map((option, i) => ({ id: randomUUID(), name: option, color: (['gray', 'blue', 'green', 'orange'] as const)[i]! }));
  const tags = ['红', '绿', '蓝'].map((option, i) => ({ id: randomUUID(), name: option, color: (['red', 'green', 'blue'] as const)[i]! }));
  const fields = {
    title: { id: randomUUID(), name: '名称', type: 'title' }, text: { id: randomUUID(), name: '备注', type: 'text' },
    number: { id: randomUUID(), name: '金额', type: 'number' }, select: { id: randomUUID(), name: '状态', type: 'select', options },
    tags: { id: randomUUID(), name: '标签', type: 'multi_select', options: tags }, date: { id: randomUUID(), name: '日期', type: 'date' },
    done: { id: randomUUID(), name: '完成', type: 'checkbox' },
  } satisfies Record<string, PropertyDefinition>;
  const view = { id: randomUUID(), name: '全部', type: 'table', filters: [], sorts: [], hiddenPropertyIds: [], propertyOrder: [], widths: {} };
  const content = JSON.stringify({ schemaVersion: 1, editorState: { root: { type: 'root', version: 1, format: '', indent: 0, direction: null, children: [] } } });
  await pool.query(`INSERT INTO pages (id, workspace_id, title, content_json, content_schema_version, kind) VALUES ($1, $2, '大表', $3::jsonb, 1, 'database')`,
    [databaseId, owner.workspaceId, content]);
  await pool.query(`INSERT INTO databases (workspace_id, page_id, properties_json, views_json) VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
    [owner.workspaceId, databaseId, JSON.stringify(Object.values(fields)), JSON.stringify([view])]);
  await pool.query(`INSERT INTO pages (id, workspace_id, parent_id, title, content_json, content_schema_version, kind, search_text, sort_position, row_properties)
    SELECT gen_random_uuid(), $1, $2, '记录 ' || n, $3::jsonb, 1, 'row', '备注内容 ' || n, n * 1024,
      jsonb_strip_nulls(jsonb_build_object($4::text, '备注内容 ' || n, $5::text, (n % 9973) * 1.5, $6::text, ($7::text[])[1 + n % 4],
        $8::text, jsonb_build_array(($9::text[])[1 + n % 3]), $10::text, to_char(date '2024-01-01' + (n % 1000), 'YYYY-MM-DD'), $11::text, CASE WHEN n % 3 = 0 THEN true END))
    FROM generate_series(1, $12::int) n`,
  [owner.workspaceId, databaseId, content, fields.text.id, fields.number.id, fields.select.id, options.map(o => o.id), fields.tags.id, tags.map(o => o.id),
    fields.date.id, fields.done.id, rowCount]);
  await pool.query('ANALYZE pages');
  console.log(`fixture ${name}: ${rowCount} rows, database ${databaseId}`);
} finally {
  await pool.end();
}
