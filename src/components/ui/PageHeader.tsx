import { createContext, type ReactNode } from 'react';

/** Kept for compatibility: the shell used to pass the section's icon and tile colour. */
export interface PageSection {
  icon?: ReactNode;
  color?: string;
}

export const PageSectionContext = createContext<PageSection>({});

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Buttons at the right. */
  actions?: ReactNode;
  /** Unused (kept so existing callers compile). */
  icon?: ReactNode | null;
  /** Unused (kept so existing callers compile). */
  iconColor?: string;
}

/** Typographic page header: title, one muted meta line, actions at the right. `icon` / `iconColor` are accepted but no longer drawn. */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {subtitle && <div className="subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}
