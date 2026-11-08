import { useState } from 'react';
import { databaseOptionLimit, optionColors, type OptionColor, type PropertyDefinition, type SelectOption } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { OptionTag } from './cells';
import { colorLabels, nextOptionColor } from './labels';

/** Rename, recolor, reorder and remove a field's options. Removing keeps the ids in rows; they read as empty. */
export function OptionEditor({ def, onChange }: { def: PropertyDefinition; onChange: (options: SelectOption[], removedId?: string) => void }) {
  const options = def.options ?? [];
  const [colorFor, setColorFor] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState('');
  const taken = (name: string, except?: string) => options.some(option => option.name === name && option.id !== except);
  /** Returns the name the input should show. */
  const rename = (option: SelectOption, value: string): string => {
    const name = value.trim().slice(0, 100);
    if (!name || name === option.name) { setProblem(''); return option.name; }
    if (taken(name, option.id)) { setProblem(`已有名为「${name}」的选项。`); return option.name; }
    setProblem('');
    onChange(options.map(item => item.id === option.id ? { ...item, name } : item));
    return name;
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= options.length || from === to) return;
    const next = [...options];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onChange(next);
  };
  const add = () => {
    const name = draft.trim().slice(0, 100);
    if (!name) return;
    if (taken(name)) { setProblem(`已有名为「${name}」的选项。`); return; }
    if (options.length >= databaseOptionLimit) { setProblem('选项数量已达上限。'); return; }
    setProblem(''); setDraft('');
    onChange([...options, { id: crypto.randomUUID(), name, color: nextOptionColor(options.length) }]);
  };
  return <div className="nb-db-options">
    <div className="nb-db-subhead">选项</div>
    {options.map((option, index) => <div key={option.id} className="nb-db-option-row" draggable onDragStart={() => setDragging(option.id)}
      onDragEnd={() => setDragging(null)} onDragOver={event => { if (dragging && dragging !== option.id) event.preventDefault(); }}
      onDrop={event => { event.preventDefault(); if (dragging) move(options.findIndex(item => item.id === dragging), index); setDragging(null); }}>
      <span className="nb-db-handle nb-db-option-handle" aria-hidden="true">⋮⋮</span>
      <button className="nb-db-color-button" aria-label={`更改「${option.name}」的颜色`} aria-expanded={colorFor === option.id}
        onClick={() => setColorFor(colorFor === option.id ? null : option.id)}><OptionTag option={{ ...option, name: ' ' }} /></button>
      <input className="nb-db-input" aria-label={`选项「${option.name}」的名称`} defaultValue={option.name} key={option.name} maxLength={100}
        onBlur={event => { event.target.value = rename(option, event.target.value); }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur(); }} />
      <button className="nb-db-tool" aria-label={`上移「${option.name}」`} disabled={index === 0} onClick={() => move(index, index - 1)}>↑</button>
      <button className="nb-db-tool" aria-label={`下移「${option.name}」`} disabled={index === options.length - 1} onClick={() => move(index, index + 1)}>↓</button>
      <button className="nb-db-tool" aria-label={`删除选项「${option.name}」`} onClick={() => onChange(options.filter(item => item.id !== option.id), option.id)}>
        <Icon name="close" size={13} /></button>
      {colorFor === option.id && <div className="nb-db-color-grid">
        {optionColors.map((color: OptionColor) => <button key={color} aria-label={colorLabels[color]} aria-pressed={option.color === color}
          className={`nb-db-tag nb-db-color-${color}`} onClick={() => { setColorFor(null); onChange(options.map(item => item.id === option.id ? { ...item, color } : item)); }}>
          {colorLabels[color]}</button>)}
      </div>}
    </div>)}
    <input className="nb-db-input" aria-label="新建选项" placeholder="新建选项，按回车添加" value={draft} maxLength={100} onChange={event => setDraft(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) add(); }} />
    {problem && <p className="nb-db-invalid-note" role="alert">{problem}</p>}
    <p className="nb-db-empty-note">删除选项后，已选的行显示为空。</p>
  </div>;
}
