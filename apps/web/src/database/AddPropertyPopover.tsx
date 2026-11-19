import { useState } from 'react';
import type { PagePropertyType } from '@nbase/contracts';
import { Popover } from '../components/Popover';
import { typeGlyphs, typeLabels } from './labels';

/** Types offered when a property is added from a page: a page's own fields, or a field added to a row's database. */
export const addablePropertyTypes: readonly PagePropertyType[] = ['text', 'number', 'date', 'select'];

/**
 * Name and type of a new property. `validate` returns a message for a name that cannot be used. `onAdd` resolves
 * false when saving failed, so the form stays open with the typed name.
 */
export function AddPropertyPopover({ validate, onAdd, onClose, label = '添加属性' }: {
  validate: (name: string) => string;
  onAdd: (name: string, type: PagePropertyType) => Promise<boolean>;
  onClose: () => void;
  label?: string;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<PagePropertyType>('text');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const trimmed = name.trim();
    const problem = validate(trimmed);
    if (problem) { setError(problem); return; }
    setBusy(true);
    const added = await onAdd(trimmed, type);
    setBusy(false);
    if (added) onClose(); else setError('暂时无法添加，请重试。');
  };
  return <Popover label={label} className="nb-db-pop nb-prop-add" portal width={240} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); if (!busy) void submit(); }}>
      <input className="nb-db-input" autoFocus aria-label="属性名称" placeholder="属性名称" value={name} maxLength={100}
        onChange={event => { setName(event.target.value); setError(''); }} />
      <div className="nb-prop-add-types" role="radiogroup" aria-label="属性类型">
        {addablePropertyTypes.map(item => <button key={item} type="button" role="radio" aria-checked={type === item}
          className={type === item ? 'selected' : undefined} onClick={() => setType(item)}>
          <span className="nb-db-glyph">{typeGlyphs[item]}</span>{typeLabels[item]}</button>)}
      </div>
      {error && <p className="nb-prop-add-error" role="alert">{error}</p>}
      <button type="submit" className="nb-btn nb-btn-primary nb-prop-add-submit" disabled={busy || !name.trim()}>添加</button>
    </form>
  </Popover>;
}
