import type { RecurrenceEditScope } from '@nbase/contracts';
import { Modal } from '../components/Modal';

const scopes: [RecurrenceEditScope, string][] = [['this', '仅此次'], ['following', '此次及以后'], ['all', '全部']];

/** Asks which occurrences of a repeating event a change or deletion applies to. */
export function RecurrenceScopeDialog({ action = 'change', onChoose, onClose }: {
  action?: 'change' | 'delete'; onChoose: (scope: RecurrenceEditScope) => void; onClose: () => void;
}) {
  const verb = action === 'delete' ? '删除' : '修改';
  return <Modal title={`${verb}重复日程`} onClose={onClose}>
    <p className="dialog-description">这是重复日程中的一次。要{verb}哪些？</p>
    <div className="nb-cal-scopes">
      {scopes.map(([scope, label], index) => <button key={scope} className={`nb-btn ${index === 0 ? 'nb-btn-primary' : ''}`} autoFocus={index === 0}
        onClick={() => onChoose(scope)}>{label}</button>)}
    </div>
    <div className="dialog-actions"><button className="nb-btn nb-btn-quiet" onClick={onClose}>取消</button></div>
  </Modal>;
}
