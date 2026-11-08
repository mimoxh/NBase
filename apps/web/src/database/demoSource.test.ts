import { describe, expect, it, vi } from 'vitest';
import { canMove, workspaceReducer, type Action, type Workspace } from '../workspace/model';
import { initialWorkspace } from '../workspace/fixtures';
import { createDemoSource } from './demoSource';

function setup() {
  const state = { current: initialWorkspace() as Workspace };
  const dispatched: Action[] = [];
  const source = createDemoSource({ state, dispatch: action => dispatched.push(action), openPage: vi.fn(), notice: vi.fn() });
  const databaseId = state.current.pages.find(page => page.kind === 'database')!.id;
  return { state, source, databaseId, dispatched };
}

describe('demo database source', () => {
  it('loads rows in order and writes through the workspace reducer', async () => {
    const { source, databaseId, state, dispatched } = setup();
    const doc = await source.load(databaseId);
    expect(doc.rows.map(row => row.title)).toEqual(['三体', '人类简史', '时间简史', '活着']);
    const status = doc.properties.find(p => p.type === 'select')!;
    const row = await source.createRow(databaseId, '新书', { [status.id]: status.options![0]!.id });
    expect((await source.load(databaseId)).rows.at(-1)).toMatchObject({ id: row.id, title: '新书' });
    expect(dispatched.map(action => action.type)).toEqual(['insert']);
    expect(state.current.pages.find(page => page.id === row.id)?.kind).toBe('row');
  });

  it('rejects stale revisions and values that do not fit the property', async () => {
    const { source, databaseId } = setup();
    const doc = await source.load(databaseId);
    const row = doc.rows[0]!;
    const rating = doc.properties.find(p => p.type === 'number')!;
    const updated = await source.updateRow(row.id, row.revision, { properties: { [rating.id]: 7 } });
    expect(updated.properties[rating.id]).toBe(7);
    await expect(source.updateRow(row.id, row.revision, { properties: { [rating.id]: 8 } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(source.updateRow(row.id, updated.revision, { properties: { [rating.id]: 'x' as unknown as number } }))
      .rejects.toMatchObject({ code: 'PROPERTY_INVALID' });
  });

  it('saves schemas with a revision check and moves or trashes rows', async () => {
    const { source, databaseId, state } = setup();
    const doc = await source.load(databaseId);
    const saved = await source.saveSchema(databaseId, { properties: doc.properties, views: doc.views.slice(0, 1) }, doc.schemaRevision);
    expect(saved.views).toHaveLength(1);
    await expect(source.saveSchema(databaseId, { properties: doc.properties, views: doc.views }, doc.schemaRevision))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await source.moveRow(databaseId, doc.rows[3]!.id, null);
    expect((await source.load(databaseId)).rows[0]!.title).toBe('活着');
    await source.trashRow(doc.rows[0]!);
    expect((await source.load(databaseId)).rows.map(row => row.title)).not.toContain('三体');
    // A row cannot come back while its database is in the trash.
    let next = workspaceReducer(state.current, { type: 'delete', id: databaseId });
    next = workspaceReducer(next, { type: 'restore', id: doc.rows[1]!.id });
    expect(next.pages.find(page => page.id === doc.rows[1]!.id)?.deleted).toBe(true);
  });

  it('keeps pages out of databases and rows in place', () => {
    const { state, databaseId } = setup();
    const row = state.current.pages.find(page => page.kind === 'row')!;
    expect(canMove(state.current.pages, 'weekly', databaseId)).toBe(false);
    expect(canMove(state.current.pages, row.id, null)).toBe(false);
    expect(canMove(state.current.pages, 'weekly', null)).toBe(true);
  });
});
