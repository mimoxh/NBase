import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { PropertyDefinition } from '@nbase/contracts';
import { initializeOwner } from '../src/auth/initialize-owner.js';
import { hashPassword } from '../src/auth/password.js';
import { runComputedBatch } from '../src/databases/computed.js';
import { runDatabaseAggregate, runDatabaseQuery } from '../src/databases/query.js';
import { runMigrations } from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations.js';
import { PgPageRepository } from '../src/pages/repository.js';

const sourceUrl = process.env.NBASE_TEST_DATABASE_URL;

test('computed results recover on upgrade and preserve edits made during a batch', {
  skip: !sourceUrl && 'Set NBASE_TEST_DATABASE_URL to a disposable local PostgreSQL instance',
}, async () => {
  assert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '54329');
  assert.equal(source.pathname, '/nbase_p2');
  const admin = new pg.Pool({ connectionString: sourceUrl });
  const name = `nbase_p2_test_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(source);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), statement_timeout: 5000 });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    await pool.query(`CREATE TABLE schema_migrations (version integer PRIMARY KEY CHECK (version > 0),
      name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const migration of migrations.filter(item => item.version <= 17)) {
      await pool.query(migration.sql);
      await pool.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, createHash('sha256').update(migration.sql).digest('hex')]);
    }
    const { workspaceId, userId } = await initializeOwner(pool, 'owner', await hashPassword('local integration password only'), '计算测试');
    const [databaseId, rowId, titleId, amountId, formulaId] = Array.from({ length: 5 }, () => randomUUID()) as [string, string, string, string, string];
    const properties: PropertyDefinition[] = [
      { id: titleId, name: '名称', type: 'title' },
      { id: amountId, name: '金额', type: 'number' },
      { id: formulaId, name: '双倍', type: 'formula', formula: { expression: `prop("${amountId}") * 2`, resultType: 'number' } },
    ];
    const content = { schemaVersion: 1, editorState: { root: { type: 'root', version: 1, children: [] } } };
    await pool.query(`INSERT INTO pages (id, workspace_id, kind, content_json, content_schema_version)
      VALUES ($1, $2, 'database', $3, 1)`, [databaseId, workspaceId, content]);
    await pool.query(`INSERT INTO databases (workspace_id, page_id, properties_json, views_json)
      VALUES ($1, $2, $3, '[]')`, [workspaceId, databaseId, JSON.stringify(properties)]);
    await pool.query(`INSERT INTO pages (id, workspace_id, parent_id, kind, content_json, content_schema_version, row_properties)
      VALUES ($1, $2, $3, 'row', $4, 1, $5)`, [rowId, workspaceId, databaseId, content, { [amountId]: 21 }]);
    await pool.query(`INSERT INTO database_computed (workspace_id, database_id, row_id, values_json)
      VALUES ($1, $2, $3, $4)`, [workspaceId, databaseId, rowId, { [formulaId]: 20 }]);

    const read = () => runDatabaseQuery(pool, workspaceId, userId, databaseId, { filters: [], sorts: [] });
    const sum = () => runDatabaseAggregate(pool, workspaceId, userId, databaseId,
      { filters: [], items: [{ propertyId: formulaId, fn: 'sum' }] });
    assert.equal((await read())?.computedStale, undefined);
    assert.deepEqual(await sum(), { values: [20] });
    await runMigrations(pool);
    assert.equal((await read())?.computedStale, true);
    assert.equal(await runComputedBatch(pool), true);
    assert.deepEqual(await sum(), { values: [42] });

    const pages = new PgPageRepository(pool);
    const edit = (expectedRevision: string, amount: number) => pages.update(workspaceId, userId, rowId, {
      expectedRevision, clientMutationId: randomUUID(), properties: { [amountId]: amount },
    });
    const initial = await edit('1', 10);
    const pausedWorker: Pick<pg.Pool, 'connect'> = {
      async connect() {
        const worker = await pool.connect();
        return new Proxy(worker, {
          get(client, key) {
            if (key !== 'query') return Reflect.get(client, key);
            return async (sql: string, values?: unknown[]) => {
              const result = await client.query(sql, values);
              if (sql.startsWith('INSERT INTO database_computed (')) {
                // Save after the worker used the old inputs and before it acknowledges that generation.
                await edit(initial.body.revision, 21);
              }
              return result;
            };
          },
        });
      },
    };
    assert.equal(await runComputedBatch(pausedWorker), true);
    const during = await read();
    assert.equal(during?.rows[0]?.computed?.[formulaId], 42);
    assert.equal(during?.computedStale, true);
    assert.deepEqual(await sum(), { values: [20], computedStale: true });
    assert.deepEqual(await runDatabaseAggregate(pool, workspaceId, userId, databaseId,
      { filters: [], items: [{ propertyId: amountId, fn: 'sum' }] }), { values: [21] });
    assert.deepEqual(await runDatabaseAggregate(pool, workspaceId, userId, databaseId, {
      filters: [{ propertyId: formulaId, operator: 'gt', value: 30 }],
      items: [{ propertyId: amountId, fn: 'sum' }],
    }), { values: [null], computedStale: true });
    assert.equal(await runComputedBatch(pool), true);
    assert.equal((await read())?.computedStale, undefined);
    assert.deepEqual(await sum(), { values: [42] });
  } finally {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});
