import { useState } from 'react';
import { activeProperties, databaseNameLimit, databasePropertyLimit, type DatabaseRow, type PagePropertyType, type PropertyDefinition,
  type PropertyValue } from '@nbase/contracts';
import { AddPropertyPopover } from './AddPropertyPopover';
import { EditableCell } from './cells';
import { typeGlyphs } from './labels';
import type { RelationHost } from './RelationEditor';
import { syncedReadOnlyHint } from './sync';
import './database.css';

/**
 * Property panel above a row's body. The row's title is edited in the page header, so the
 * title property is left out here. Writes go through the host, which owns the page revision.
 */
export function RowProperties({ row, properties, editable, pending, onChange, onCreateOption, onOpenDatabase, databaseTitle,
  databaseIcon, relationHostFor, locked, onAddProperty }: {
  /** Adds a field to the row's database; absent when the reader may not change the schema. */
  onAddProperty?: ((name: string, type: PagePropertyType) => Promise<boolean>) | undefined;
  /** Properties a calendar subscription writes; they only show. */
  locked?: ReadonlySet<string> | undefined;
  relationHostFor?: ((def: PropertyDefinition) => RelationHost) | undefined;
  row: DatabaseRow;
  properties: PropertyDefinition[];
  editable: boolean;
  pending: boolean;
  onChange: (propertyId: string, value: PropertyValue | null) => void;
  onCreateOption?: ((def: PropertyDefinition, name: string) => Promise<string | null>) | undefined;
  onOpenDatabase?: (() => void) | undefined;
  databaseTitle?: string | undefined;
  databaseIcon?: string | null | undefined;
}) {
  const [adding, setAdding] = useState(false);
  const active = activeProperties(properties);
  const shown = active.filter(def => def.type !== 'title');
  const full = active.length >= databasePropertyLimit;
  const nameProblem = (name: string) => !name ? '请输入属性名称。'
    : [...name].length > databaseNameLimit || /[\u0000-\u001f\u007f\p{Cs}]/u.test(name) ? '名称过长或含有不支持的字符。'
      : active.some(def => def.name.trim().toLowerCase() === name.toLowerCase()) ? '数据库里已有同名字段。' : '';
  return <section className={`nb-db-row-props ${pending ? 'pending' : ''}`} aria-label="行属性">
    {onOpenDatabase && <button className="nb-db-row-source" onClick={onOpenDatabase}>
      <span aria-hidden="true">{databaseIcon ?? '🗃️'}</span>{databaseTitle || '未命名数据库'}</button>}
    {shown.map(def => <div key={def.id} className="nb-db-row-prop">
      <span className="nb-db-row-label"><span className="nb-db-glyph">{typeGlyphs[def.type]}</span>{def.name}</span>
      <span className="nb-db-anchor nb-db-row-value">
        <EditableCell row={row} def={def} editable={editable} locked={locked?.has(def.id)} onTitle={() => undefined} relationHost={relationHostFor?.(def)}
          onChange={value => onChange(def.id, value)}
          onCreateOption={editable && onCreateOption ? (name: string) => onCreateOption(def, name) : undefined} />
        {editable && locked?.has(def.id) && <span className="nb-db-locked-hint">{syncedReadOnlyHint}</span>}
      </span>
    </div>)}
    {!shown.length && <p className="nb-db-empty-note">这个数据库还没有其他字段。</p>}
    {onAddProperty && <div className="nb-db-anchor nb-page-props-add">
      <button className="nb-page-props-add-button" disabled={full} title={full ? '字段数量已达上限' : '新属性会作为字段加入所属数据库'}
        onClick={() => setAdding(true)}>＋ 添加属性</button>
      {adding && <AddPropertyPopover label="添加数据库字段" validate={nameProblem} onAdd={onAddProperty} onClose={() => setAdding(false)} />}
    </div>}
  </section>;
}
