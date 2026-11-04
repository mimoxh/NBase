import { Icon } from '../components/Icon';

export function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  return <div className="nb-toast" role="status"><Icon name="check" size={16} /><span>{text}</span>
    <button className="icon-button" aria-label="关闭提示" onClick={onClose}><Icon name="close" /></button></div>;
}
