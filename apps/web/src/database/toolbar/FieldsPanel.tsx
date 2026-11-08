import { databasePropertyLimit, type DatabaseView as View, type PropertyDefinition } from '@nbase/contracts';
import { Icon } from '../../components/Icon';
import { Popover } from '../../components/Popover';
import { typeGlyphs } from '../labels';

export function FieldsPanel({ view, properties, active, canWrite, open, onOpen, onClose, onUpdate, onRestore }: {
  view: View; properties: PropertyDefinition[]; active: PropertyDefinition[]; canWrite: boolean; open: boolean;
  onOpen: () => void; onClose: () => void; onUpdate: (patch: Partial<View>) => void; onRestore: (id: string) => void;
}) {
  const deleted = properties.filter(p => p.deletedAt);
  return <span className="nb-db-anchor">
    <button className="nb-db-tool" onClick={onOpen}><Icon name="settings" size={14} />字段</button>
    {open && <Popover label="字段" className="nb-db-pop" onClose={onClose}>
      <div className="nb-db-prop-list">
        {active.map(def => <label key={def.id} className="nb-db-prop-row">
          <input type="checkbox" disabled={!canWrite || def.type === 'title'} checked={!view.hiddenPropertyIds.includes(def.id)}
            onChange={event => onUpdate({ hiddenPropertyIds: event.target.checked
              ? view.hiddenPropertyIds.filter(id => id !== def.id) : [...view.hiddenPropertyIds, def.id] })} />
          <span className="nb-db-glyph">{typeGlyphs[def.type]}</span>{def.name}</label>)}
      </div>
      {deleted.length > 0 && <>
        <div className="nb-db-subhead">已删除的字段</div>
        {deleted.map(def => <div key={def.id} className="nb-db-prop-row">
          <span className="nb-db-glyph">{typeGlyphs[def.type]}</span><span className="nb-db-grow">{def.name}</span>
          {canWrite && <button className="nb-btn nb-btn-quiet" disabled={active.length >= databasePropertyLimit}
            onClick={() => onRestore(def.id)}>恢复</button>}
        </div>)}
      </>}
    </Popover>}
  </span>;
}
