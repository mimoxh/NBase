import type { ReactNode } from 'react';

/** Inline banner under the topbar; replaces the old alert strips without changing their copy. */
export function NoticeBar({ tone, children, alert = false }: {
  tone: 'info' | 'warn' | 'danger'; children: ReactNode; alert?: boolean;
}) {
  return <div className={`nb-notice nb-notice-${tone}`} role={alert ? 'alert' : 'status'}>{children}</div>;
}
