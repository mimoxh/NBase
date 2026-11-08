import { activeProperties, type DatabaseRow, type PropertyDefinition, type PropertyValue } from '@nbase/contracts';
import { EditableCell } from './cells';
import { typeGlyphs } from './labels';
import './database.css';

/**
 * Property panel above a row's body. The row's title is edited in the page header, so the
 * title property is left out here. Writes go through the host, which owns the page revision.
 */
export function RowProperties({ row, properties, editable, pending, onChange, onCreateOption, onOpenDatabase, databaseTitle,
  databaseIcon }: {
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
  const shown = activeProperties(properties).filter(def => def.type !== 'title');
  return <section className={`nb-db-row-props ${pending ? 'pending' : ''}`} aria-label="行属性">
    {onOpenDatabase && <button className="nb-db-row-source" onClick={onOpenDatabase}>
      <span aria-hidden="true">{databaseIcon ?? '🗃️'}</span>{databaseTitle || '未命名数据库'}</button>}
    {shown.map(def => <div key={def.id} className="nb-db-row-prop">
      <span className="nb-db-row-label"><span className="nb-db-glyph">{typeGlyphs[def.type]}</span>{def.name}</span>
      <span className="nb-db-anchor nb-db-row-value">
        <EditableCell row={row} def={def} editable={editable} onTitle={() => undefined}
          onChange={value => onChange(def.id, value)}
          onCreateOption={editable && onCreateOption ? (name: string) => onCreateOption(def, name) : undefined} />
      </span>
    </div>)}
    {!shown.length && <p className="nb-db-empty-note">这个数据库还没有其他字段。</p>}
  </section>;
}
