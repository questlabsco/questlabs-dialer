import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: ReactNode;
  message?: ReactNode;
  /** Large icon above the title, e.g. <IconLeads size={32} />. */
  icon?: ReactNode;
  /** Button(s) below the message. */
  action?: ReactNode;
}

export function EmptyState({ title, message, icon, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {icon && <div className="icon">{icon}</div>}
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      {action && <div className="action">{action}</div>}
    </div>
  );
}
