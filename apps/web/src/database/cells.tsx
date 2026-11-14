import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cellValue, effectiveType, isComputedProperty, isUrlValue, type DatabaseRow, type PropertyDefinition, type PropertyValue,
  type SelectOption } from '@nbase/contracts';
import { Popover } from '../components/Popover';
import { formatNumber, formatTimestamp } from './labels';
import { RelationEditor, type RelationHost } from './RelationEditor';
import { tagNames, useDatabaseTags } from './tags';

export function OptionTag({ option }: { option: SelectOption }) {
  return <span className={`nb-db-tag nb-db-color-${option.color}`}>{option.name}</span>;
}

/** Read-only rendering of a cell, used both in the table and in the row property panel. */
export function CellValue({ row, def }: { row: DatabaseRow; def: PropertyDefinition }) {
  const tagHost = useDatabaseTags();
  const value = cellValue(row, def);
  const kind = effectiveType(def);
  if (value === undefined) return kind === 'checkbox' ? <span className="nb-db-check" aria-label="未勾选" /> : null;
  if (kind === 'checkbox' && value !== true) return <span className="nb-db-check" aria-label="未勾选" />;
  switch (kind) {
    case 'relation': {
      const cell = row.relations![def.id]!;
      return <span className="nb-db-tags">{cell.items.map(item => <span key={item.id} className="nb-db-tag nb-db-color-default">{item.title || '未命名'}</span>)}
        {cell.total > cell.items.length && <span className="nb-db-muted">+{cell.total - cell.items.length}</span>}</span>;
    }
    case 'tags': return <span className="nb-db-tags">{tagNames(tagHost, row).map(name =>
      <span key={name} className="nb-db-tag nb-db-color-default">{name}</span>)}</span>;
    case 'title': return <span className="nb-db-title-text">{String(value)}</span>;
    case 'number': return <span className="nb-db-number">{formatNumber(value as number)}</span>;
    case 'checkbox': return <span className="nb-db-check checked" aria-label="已勾选">✓</span>;
    case 'select': {
      const option = def.options?.find(item => item.id === value);
      return option ? <OptionTag option={option} /> : null;
    }
    case 'multi_select': return <span className="nb-db-tags">{(value as string[]).map(id => def.options?.find(item => item.id === id))
      .filter((option): option is SelectOption => Boolean(option)).map(option => <OptionTag key={option.id} option={option} />)}</span>;
    case 'url': return <a className="nb-db-link" href={String(value)} target="_blank" rel="noreferrer noopener"
      onClick={event => event.stopPropagation()}>{String(value).replace(/^https?:\/\//, '')}</a>;
    case 'created_time': case 'updated_time': return <span className="nb-db-muted">{formatTimestamp(String(value))}</span>;
    default: return <span className="nb-db-text">{String(value)}</span>;
  }
}

/** Where the cursor goes when an edit ends from the keyboard. */
export type CellNavigation = 'down' | 'right' | 'left' | 'stay';

let editSeed: string | null = null;

/** Text typed on a selected cell, picked up by the editor that opens next. */
export function setCellEditSeed(text: string): void { editSeed = text; }

export function takeCellEditSeed(): string | null {
  const seed = editSeed;
  editSeed = null;
  return seed;
}

function TextInput({ initial, type = 'text', onCommit, onCancel, onNavigate, label }: {
  initial: string; type?: 'text' | 'number' | 'url' | 'date'; label: string;
  onCommit: (value: string) => void; onCancel: () => void; onNavigate?: ((direction: CellNavigation) => void) | undefined;
}) {
  const [value, setValue] = useState(() => takeCellEditSeed() ?? initial);
  const composing = useRef(false);
  const done = useRef(false);
  const commit = () => { if (!done.current) { done.current = true; onCommit(value); } };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') { event.preventDefault(); commit(); onNavigate?.('down'); }
    if (event.key === 'Tab' && onNavigate) { event.preventDefault(); commit(); onNavigate(event.shiftKey ? 'left' : 'right'); }
    if (event.key === 'Escape') { event.preventDefault(); done.current = true; onCancel(); onNavigate?.('stay'); }
  };
  return <input className="nb-db-input" autoFocus aria-label={label} type={type === 'url' ? 'url' : type}
    value={value} onChange={event => setValue(event.target.value)} onBlur={commit} onKeyDown={keyDown}
    {...(type === 'number' ? { inputMode: 'decimal' as const, step: 'any' } : {})}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />;
}

export function SelectEditor({ def, value, multiple, onChange, onCreateOption, onClose }: {
  def: PropertyDefinition; value: string[]; multiple: boolean;
  onChange: (next: string[]) => void; onCreateOption?: ((name: string) => Promise<string | null>) | undefined; onClose: () => void;
}) {
  const [query, setQuery] = useState(() => takeCellEditSeed() ?? '');
  const [busy, setBusy] = useState(false);
  const options = def.options ?? [];
  const q = query.trim();
  const visible = options.filter(option => option.name.toLocaleLowerCase().includes(q.toLocaleLowerCase()));
  const exact = options.some(option => option.name === q);
  const toggle = (id: string) => {
    if (multiple) onChange(value.includes(id) ? value.filter(item => item !== id) : [...value, id]);
    else { onChange(value[0] === id ? [] : [id]); onClose(); }
  };
  const create = async () => {
    if (!onCreateOption || !q || exact || busy) return;
    setBusy(true);
    const id = await onCreateOption(q);
    setBusy(false);
    if (!id) return;
    setQuery('');
    if (multiple) onChange([...value, id]); else { onChange([id]); onClose(); }
  };
  return <Popover label={`选择${def.name}`} className="nb-db-pop nb-db-select-pop" onClose={onClose} portal width={260}>
    {value.length > 0 && <div className="nb-db-tags nb-db-selected">{value.map(id => options.find(option => option.id === id))
      .filter((option): option is SelectOption => Boolean(option)).map(option => <button key={option.id} className="nb-db-tag-button"
        aria-label={`移除 ${option.name}`} onClick={() => toggle(option.id)}><OptionTag option={option} /> ×</button>)}</div>}
    <input className="nb-db-input" autoFocus placeholder={onCreateOption ? '搜索或新建选项' : '搜索选项'} value={query}
      aria-label="搜索选项" onChange={event => setQuery(event.target.value)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          const first = visible[0];
          if (first && (exact || !onCreateOption || !q)) toggle(first.id); else void create();
        }
      }} />
    <div className="nb-db-option-list" role="listbox" aria-multiselectable={multiple}>
      {visible.map(option => <button key={option.id} role="option" aria-selected={value.includes(option.id)}
        className={`nb-db-option ${value.includes(option.id) ? 'selected' : ''}`} onClick={() => toggle(option.id)}>
        <OptionTag option={option} />{value.includes(option.id) && <span className="nb-db-option-check">✓</span>}
      </button>)}
      {q && !exact && onCreateOption && <button className="nb-db-option" disabled={busy} onClick={() => void create()}>
        新建选项 <strong>{q}</strong></button>}
      {!visible.length && (!q || !onCreateOption) && <p className="nb-db-empty-note">暂无选项</p>}
    </div>
  </Popover>;
}

/**
 * Click-to-edit cell. Checkbox toggles at once; text-like types use an inline input; select
 * types open a picker. Values reach `onChange` already typed; null clears the cell.
 */
export function EditableCell({ row, def, editable, onChange, onTitle, onCreateOption, onNavigate, relationHost }: {
  row: DatabaseRow; def: PropertyDefinition; editable: boolean;
  relationHost?: RelationHost | undefined;
  onChange: (value: PropertyValue | null) => void;
  onTitle: (title: string) => void;
  onCreateOption?: ((name: string) => Promise<string | null>) | undefined;
  onNavigate?: ((direction: CellNavigation) => void) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState('');
  useEffect(() => { if (!invalid) return; const timer = setTimeout(() => setInvalid(''), 3000); return () => clearTimeout(timer); }, [invalid]);
  const tagHost = useDatabaseTags();
  const readOnlyType = def.type === 'created_time' || def.type === 'updated_time' || isComputedProperty(def)
    || (def.type === 'tags' && !tagHost?.setRowTags);
  const value = cellValue(row, def);
  if (!editable || readOnlyType || (def.type === 'relation' && !relationHost)) return <CellValue row={row} def={def} />;
  if (def.type === 'relation') {
    return <>
      <button className="nb-db-cell-button" aria-label={`编辑${def.name}`} onClick={() => setEditing(true)}><CellValue row={row} def={def} /></button>
      {editing && <RelationEditor row={row} def={def} host={relationHost!} onClose={() => { setEditing(false); onNavigate?.('stay'); }} />}
    </>;
  }
  if (def.type === 'tags') {
    // The choices are the workspace's tags; new ones are made in the tag manager, not here.
    const choices: PropertyDefinition = { ...def, type: 'multi_select',
      options: tagHost!.tags.map(tag => ({ id: tag.id, name: tag.name, color: 'default' as const })) };
    const selected = (row.tagIds ?? []).filter(id => tagHost!.tags.some(tag => tag.id === id));
    return <>
      <button className="nb-db-cell-button" aria-label={`编辑${def.name}`} onClick={() => setEditing(true)}><CellValue row={row} def={def} /></button>
      {editing && <SelectEditor def={choices} value={selected} multiple onClose={() => { setEditing(false); onNavigate?.('stay'); }}
        onChange={next => tagHost!.setRowTags!(row, next)} />}
    </>;
  }
  if (def.type === 'checkbox') {
    return <button className="nb-db-cell-button" role="checkbox" aria-checked={value === true} aria-label={def.name}
      onClick={() => onChange(value === true ? null : true)}><CellValue row={row} def={def} /></button>;
  }
  if (def.type === 'select' || def.type === 'multi_select') {
    // A removed option's id stays in the row but must not be sent back; the server would refuse the whole value.
    const selected = (value === undefined ? [] : Array.isArray(value) ? value : [String(value)])
      .filter(id => def.options?.some(option => option.id === id));
    return <>
      <button className="nb-db-cell-button" aria-label={`编辑${def.name}`} onClick={() => setEditing(true)}>
        <CellValue row={row} def={def} /></button>
      {editing && <SelectEditor def={def} value={selected} multiple={def.type === 'multi_select'} onCreateOption={onCreateOption}
        onClose={() => { setEditing(false); onNavigate?.('stay'); }}
        onChange={next => onChange(def.type === 'select' ? next[0] ?? null : next.length ? next : null)} />}
    </>;
  }
  if (editing) {
    const initial = value === undefined ? '' : String(value);
    const type = def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : def.type === 'url' ? 'url' : 'text';
    return <TextInput initial={initial} type={type} label={def.name} onNavigate={onNavigate} onCancel={() => setEditing(false)} onCommit={text => {
      setEditing(false);
      const trimmed = def.type === 'title' ? text : text.trim();
      if (def.type === 'title') { if (trimmed !== row.title) onTitle(trimmed); return; }
      if (trimmed === initial) return;
      if (!trimmed) { onChange(null); return; }
      if (def.type === 'number') {
        const number = Number(trimmed);
        if (!Number.isFinite(number)) { setInvalid('请输入数字'); return; }
        onChange(number); return;
      }
      if (def.type === 'url') {
        const url = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
        if (!isUrlValue(url)) { setInvalid('请输入 http、https 或 mailto 链接'); return; }
        onChange(url); return;
      }
      onChange(trimmed);
    }} />;
  }
  return <button className="nb-db-cell-button" aria-label={`编辑${def.name}`} onClick={() => setEditing(true)}>
    <CellValue row={row} def={def} />
    {def.type === 'title' && !row.title && <span className="nb-db-placeholder">未命名</span>}
    {invalid && <span className="nb-db-invalid" role="alert">{invalid}</span>}
  </button>;
}
