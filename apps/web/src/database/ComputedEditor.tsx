import { useEffect, useMemo, useState } from 'react';
import { activeProperties, effectiveType, formulaFromDisplay, formulaToDisplay, isComputedProperty, parseFormula, rollupFunctions, type ComputedResultType, type PropertyDefinition, type RollupFunction } from '@nbase/contracts';
import { rollupLabels, typeLabels } from './labels';
import type { DatabaseDataSource } from './source';

const resultNames: Record<ComputedResultType, string> = { number: '数字', text: '文本', checkbox: '真假值', date: '日期' };

/** Edits a formula as text with field names, and saves it only when it parses. */
export function FormulaEditor({ def, properties, onSave }: { def: PropertyDefinition; properties: PropertyDefinition[]; onSave: (next: NonNullable<PropertyDefinition['formula']>) => void }) {
  const [text, setText] = useState(() => formulaToDisplay(def.formula!.expression, properties));
  const fields = activeProperties(properties).filter(p => !isComputedProperty(p) && p.type !== 'relation');
  const expression = useMemo(() => formulaFromDisplay(text, properties), [text, properties]);
  const parsed = useMemo(() => parseFormula(expression, properties), [expression, properties]);
  const blank = !text.trim();
  return <div className="nb-db-formula">
    <textarea className="nb-db-input" aria-label="公式" rows={3} spellCheck={false} value={text} onChange={event => setText(event.target.value)}
      placeholder={'例如 prop("单价") * prop("数量")'} />
    <p className={parsed.ok || blank ? 'nb-db-empty-note' : 'nb-db-invalid-note'} role="status">
      {parsed.ok ? `结果是${resultNames[parsed.type]}` : blank ? '可用 if、concat、round、sum、dateAdd 等函数' : parsed.error}</p>
    <div className="nb-db-formula-fields" aria-label="插入字段">{fields.map(field => <button key={field.id} className="nb-db-tag nb-db-color-default"
      onClick={() => setText(`${text}prop("${field.name}")`)}>{field.name}</button>)}</div>
    <button className="nb-btn nb-btn-primary" disabled={!parsed.ok && !blank} onClick={() => onSave({ expression: blank ? '' : expression, resultType: parsed.ok ? parsed.type : 'text' })}>保存公式</button>
  </div>;
}

function resultTypeOf(fn: RollupFunction, target: PropertyDefinition | undefined): ComputedResultType {
  if (fn !== 'min' && fn !== 'max') return 'number';
  const kind = target ? effectiveType(target) : 'number';
  if (kind === 'number') return 'number';
  return kind === 'date' || kind === 'created_time' || kind === 'updated_time' ? 'date' : 'text';
}

/** Chooses which relation to read, which field of the linked rows, and how to combine them. */
export function RollupEditor({ def, properties, source, onSave }: { def: PropertyDefinition; properties: PropertyDefinition[]; source: DatabaseDataSource; onSave: (next: NonNullable<PropertyDefinition['rollup']>) => void }) {
  const relations = activeProperties(properties).filter(p => p.type === 'relation');
  const { relationPropertyId, targetPropertyId, fn } = def.rollup!;
  const relation = relations.find(p => p.id === relationPropertyId) ?? relations[0];
  const [targets, setTargets] = useState<PropertyDefinition[]>([]);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    if (!relation?.relation) return;
    let cancelled = false;
    source.load(relation.relation.databaseId)
      .then(doc => { if (!cancelled) { setTargets(activeProperties(doc.properties).filter(p => p.type !== 'rollup')); setProblem(''); } })
      .catch(() => { if (!cancelled) setProblem('关联的数据库暂时无法读取。'); });
    return () => { cancelled = true; };
  }, [source, relation?.relation?.databaseId, relation?.relation]);
  const save = (patch: Partial<NonNullable<PropertyDefinition['rollup']>>) => {
    const nextRelation = patch.relationPropertyId ?? relation!.id;
    const nextFn = patch.fn ?? fn;
    const nextTarget = patch.targetPropertyId ?? targets.find(p => p.id === targetPropertyId)?.id ?? targets[0]?.id ?? targetPropertyId;
    onSave({ relationPropertyId: nextRelation, targetPropertyId: nextTarget, fn: nextFn, resultType: resultTypeOf(nextFn, targets.find(p => p.id === nextTarget)) });
  };
  if (!relation) return <p className="nb-db-empty-note">需要先添加一个关联字段。</p>;
  return <div className="nb-db-formula">
    <label className="nb-db-field-row">关联
      <select className="nb-db-select" aria-label="汇总使用的关联" value={relation.id} onChange={event => save({ relationPropertyId: event.target.value })}>
        {relations.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label className="nb-db-field-row">字段
      <select className="nb-db-select" aria-label="被汇总的字段" value={targets.some(p => p.id === targetPropertyId) ? targetPropertyId : ''} onChange={event => save({ targetPropertyId: event.target.value })}>
        {!targets.some(p => p.id === targetPropertyId) && <option value="">选择字段</option>}
        {targets.map(p => <option key={p.id} value={p.id}>{p.name}（{typeLabels[p.type]}）</option>)}</select></label>
    <label className="nb-db-field-row">方式
      <select className="nb-db-select" aria-label="汇总方式" value={fn} onChange={event => save({ fn: event.target.value as RollupFunction })}>
        {rollupFunctions.map(item => <option key={item} value={item}>{rollupLabels[item]}</option>)}</select></label>
    {problem && <p className="nb-db-invalid-note" role="alert">{problem}</p>}
  </div>;
}
