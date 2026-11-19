import { Icon, type IconName } from '../components/Icon';
import { Modal } from '../components/Modal';

export interface ExportOption {
  key: string;
  label: string;
  description: string;
  icon?: IconName;
  disabled?: boolean;
  onSelect: () => void;
}

/** One place for every way a page leaves the app; choosing a format closes the dialog first. */
export function ExportDialog({ title = '导出页面', options, onClose }: { title?: string; options: ExportOption[]; onClose: () => void }) {
  return <Modal title={title} onClose={onClose}>
    <div className="nb-export-options" role="group" aria-label="导出格式">
      {options.map(option => <button key={option.key} type="button" className="nb-export-option" disabled={option.disabled}
        onClick={() => { onClose(); option.onSelect(); }}>
        <span className="nb-export-icon" aria-hidden="true"><Icon name={option.icon ?? 'download'} size={16} /></span>
        <span className="nb-export-text"><strong>{option.label}</strong><small>{option.description}</small></span>
      </button>)}
    </div>
  </Modal>;
}

/** The print dialog opens after the export dialog has closed, so it never ends up on the page. */
export const printPage = () => { window.setTimeout(() => window.print(), 0); };
