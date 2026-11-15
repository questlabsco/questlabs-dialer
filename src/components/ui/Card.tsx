import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Rendered at the right of the header. */
  actions?: ReactNode;
  /** Wrap children in padded .card-body (default true). */
  padded?: boolean;
}

export function Card({ title, subtitle, actions, padded = true, className, children, ...rest }: CardProps) {
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <section className={`card ${className ?? ''}`.trim()} {...rest}>
      {hasHeader && (
        <header className="card-header">
          <div>
            {title !== undefined && <h2>{title}</h2>}
            {subtitle !== undefined && <div className="subtitle">{subtitle}</div>}
          </div>
          {actions !== undefined && <div className="actions">{actions}</div>}
        </header>
      )}
      {padded ? <div className="card-body">{children}</div> : children}
    </section>
  );
}
