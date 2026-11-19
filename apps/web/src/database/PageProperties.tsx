import { useEffect, useRef, useState } from 'react';
import {
  isDateCellValue, isPagePropertyName, pagePropertyDisplayValue, pagePropertyLimit, pagePropertyNameKey, pagePropertyOptionLimit,
  pagePropertyReservedNames, type DatabaseRow, type PageProperty, type PagePropertyType, type PropertyDefinition, type PropertyValue,
} from '@nbase/contracts';
import { Popover } from '../components/Popover';
import { AddPropertyPopover, addablePropertyTypes } from './AddPropertyPopover';
import { EditableCell } from './cells';
import { nextOptionColor, typeGlyphs, typeLabels } from './labels';
import './database.css';

/** Message for a name a page property cannot take, or '' when it can. `except` is the property being renamed. */
export function pagePropertyNameProblem(name: string, properties: readonly PageProperty[], except?: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '请输入属性名称。';
  if ((pagePropertyReservedNames as readonly string[]).includes(pagePropertyNameKey(trimmed))) return 'title、tags、date 是保留名称。';
  if (!isPagePropertyName(trimmed)) return '名称过长或含有不支持的字符。';
  const key = pagePropertyNameKey(trimmed);
  if (properties.some(item => item.id !== except && pagePropertyNameKey(item.name) === key)) return '已有同名属性。';
  return '';
}

/** Keeps what still fits the new type: numbers from numeric text, dates from date text, a select option from any value. */
export function convertPageProperty(property: PageProperty, type: PagePropertyType): PageProperty {
  if (property.type === type) return property;
  const shown = pagePropertyDisplayValue(property);
  const text = shown === null ? '' : String(shown).trim();
  const base = { id: property.id, name: property.name, type };
  switch (type) {
    case 'text': return { ...base, value: text ? text.slice(0, 2000) : null };
    case 'number': {
      const number = text ? Number(text) : Number.NaN;
      return { ...base, value: Number.isFinite(number) ? number : null };
    }
    case 'date': return { ...base, value: isDateCellValue(text) ? text : null };
    case 'select': {
      if (!text) return { ...base, value: null, options: [] };
      const option = { id: crypto.randomUUID(), name: [...text].slice(0, 100).join(''), color: nextOptionColor(0) };
      return { ...base, value: option.id, options: [option] };
    }
  }
}

function definition(property: PageProperty): PropertyDefinition {
  return { id: property.id, name: property.name, type: property.type, ...(property.type === 'select' ? { options: property.options ?? [] } : {}) };
}

function rowOf(property: PageProperty): DatabaseRow {
  return { id: property.id, title: '', icon: null, properties: property.value === null ? {} : { [property.id]: property.value },
    revision: '0', createdAt: '', updatedAt: '' };
}

/**
 * The page's own properties, shown under its title. Saves go through the host, which owns the page revision; they
 * run one at a time, each sending the whole list as the user last left it, so quick edits never race each other.
 */
export function PageProperties({ properties, editable, adding, onAddingChange, onSave }: {
  properties: PageProperty[];
  editable: boolean;
  /** The "add property" form is open; the host can open it from elsewhere, such as the page header. */
  adding: boolean;
  onAddingChange: (open: boolean) => void;
  onSave: (next: PageProperty[]) => Promise<boolean>;
}) {
  const [shown, setShown] = useState(properties);
  const [pending, setPending] = useState(0);
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string; error: string } | null>(null);
  const latest = useRef(properties);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pendingRef = useRef(0);
  const serverRef = useRef(properties);
  serverRef.current = properties;
  // Compared by content: a host that rebuilds an equal list on every render must not undo edits it already accepted.
  const serverKey = JSON.stringify(properties);
  useEffect(() => {
    if (pendingRef.current) return;
    latest.current = serverRef.current;
    setShown(serverRef.current);
  }, [serverKey]);

  const save = (change: (current: PageProperty[]) => PageProperty[]): Promise<boolean> => {
    const next = change(latest.current);
    latest.current = next;
    setShown(next);
    pendingRef.current += 1; setPending(pendingRef.current);
    const done = queue.current.then(() => onSave(next)).then(ok => ok, () => false);
    queue.current = done;
    return done.then(ok => {
      pendingRef.current -= 1; setPending(pendingRef.current);
      // After a failed save the page still holds the server's list, so show that again.
      if (!ok && !pendingRef.current) { latest.current = serverRef.current; setShown(serverRef.current); }
      return ok;
    });
  };
  const update = (id: string, patch: (property: PageProperty) => PageProperty) =>
    save(current => current.map(item => item.id === id ? patch(item) : item));

  if (!shown.length && !adding) return null;
  const full = shown.length >= pagePropertyLimit;
  return <section className={`nb-db-row-props nb-page-props ${pending ? 'pending' : ''}`} aria-label="页面属性">
    {shown.map(property => {
      const def = definition(property);
      return <div key={property.id} className="nb-db-row-prop">
        <span className="nb-db-anchor nb-db-row-label">
          {editable ? <button className="nb-page-prop-name" aria-label={`属性「${property.name}」的设置`} onClick={() => setMenu(property.id)}>
            <span className="nb-db-glyph">{typeGlyphs[property.type]}</span><span>{property.name}</span></button>
            : <><span className="nb-db-glyph">{typeGlyphs[property.type]}</span><span>{property.name}</span></>}
          {menu === property.id && <Popover label={`属性「${property.name}」`} className="nb-db-pop nb-page-prop-menu" portal width={220}
            onClose={() => { setMenu(null); setRenaming(null); }}>
            <form className="nb-page-prop-rename" onSubmit={event => {
              event.preventDefault();
              const name = (renaming?.id === property.id ? renaming.name : property.name).trim();
              const problem = pagePropertyNameProblem(name, latest.current, property.id);
              if (problem) { setRenaming({ id: property.id, name, error: problem }); return; }
              if (name !== property.name) void update(property.id, item => ({ ...item, name }));
              setMenu(null); setRenaming(null);
            }}>
              <input className="nb-db-input" aria-label="属性名称" maxLength={100} autoFocus
                value={renaming?.id === property.id ? renaming.name : property.name}
                onChange={event => setRenaming({ id: property.id, name: event.target.value, error: '' })} />
              {renaming?.id === property.id && renaming.error && <p className="nb-prop-add-error" role="alert">{renaming.error}</p>}
            </form>
            <div className="nb-db-menu" role="group" aria-label="属性类型">
              {addablePropertyTypes.map(type => <button key={type} aria-pressed={property.type === type}
                onClick={() => { if (type !== property.type) void update(property.id, item => convertPageProperty(item, type)); setMenu(null); }}>
                <span className="nb-db-glyph">{typeGlyphs[type]}</span>{typeLabels[type]}{property.type === type && <span className="nb-db-option-check">✓</span>}
              </button>)}
              <button className="danger" onClick={() => { void save(current => current.filter(item => item.id !== property.id)); setMenu(null); }}>
                删除属性</button>
            </div>
          </Popover>}
        </span>
        <span className="nb-db-anchor nb-db-row-value">
          <EditableCell row={rowOf(property)} def={def} editable={editable} plainDates onTitle={() => undefined}
            onChange={(value: PropertyValue | null) => void update(property.id, item => ({ ...item,
              value: typeof value === 'string' || typeof value === 'number' ? value : null }))}
            onCreateOption={editable ? async (name: string) => {
              const current = latest.current.find(item => item.id === property.id);
              if (!current || (current.options?.length ?? 0) >= pagePropertyOptionLimit) return null;
              const option = { id: crypto.randomUUID(), name: name.slice(0, 100), color: nextOptionColor(current.options?.length ?? 0) };
              // The picker selects the new option right after this resolves, which queues behind this save.
              void update(property.id, item => ({ ...item, options: [...(item.options ?? []), option] }));
              return option.id;
            } : undefined} />
        </span>
      </div>;
    })}
    {editable && <div className="nb-db-anchor nb-page-props-add">
      <button className="nb-page-props-add-button" disabled={full} title={full ? `每页最多 ${pagePropertyLimit} 个属性` : undefined}
        onClick={() => onAddingChange(true)}>＋ 添加属性</button>
      {adding && <AddPropertyPopover validate={name => pagePropertyNameProblem(name, latest.current)} onClose={() => onAddingChange(false)}
        onAdd={(name, type) => save(current => [...current,
          { id: crypto.randomUUID(), name, type, value: null, ...(type === 'select' ? { options: [] } : {}) }])} />}
    </div>}
  </section>;
}
