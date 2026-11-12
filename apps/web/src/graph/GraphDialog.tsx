import type { ComponentProps } from 'react';
import { Modal } from '../components/Modal';
import { GraphView } from './GraphView';

/** Full-size host for the workspace graph; `graph.css` widens the large modal that contains it. */
export function GraphDialog({ onClose, ...view }: ComponentProps<typeof GraphView> & { onClose: () => void }) {
  return <Modal title="关系图" variant="large" onClose={onClose}><GraphView {...view} /></Modal>;
}
