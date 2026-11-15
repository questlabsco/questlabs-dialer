import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './IconButton';
import { IconClose } from './icons';

export interface DrawerProps {
  open: boolean;
  /** Called on Escape, overlay click, or the close button. */
  onClose: () => void;
  title: ReactNode;
  /** Muted line under the title (e.g. company, phone). */
  subtitle?: ReactNode;
  children: ReactNode;
  /** Buttons, right-aligned in the footer. */
  footer?: ReactNode;
  /** Panel width in px or any CSS length. Default 480. */
  width?: number | string;
  /** Prevent closing via Escape/overlay (e.g. while saving). Default true. */
  dismissible?: boolean;
  /** Extra content in the header, left of the close button (e.g. a status Badge). */
  headerActions?: ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Right-side panel for record details. Portal, focus trap, Escape to close, focus restored on close. */
export function Drawer({ open, onClose, title, subtitle, children, footer, width = 480, dismissible = true, headerActions }: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>('[data-autofocus]') ?? node?.querySelector<HTMLElement>(`.drawer-body ${FOCUSABLE}`) ?? node;
    first?.focus();
    return () => {
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && dismissible) {
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (e.key === 'Tab' && ref.current) {
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div
      className="drawer-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissible) onCloseRef.current();
      }}
    >
      <div ref={ref} className="drawer" style={{ width }} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="drawer-header">
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId}>{title}</h2>
            {subtitle !== undefined && <div className="subtitle">{subtitle}</div>}
          </div>
          {headerActions !== undefined && <div className="row" style={{ marginLeft: 'auto' }}>{headerActions}</div>}
          {dismissible && (
            <IconButton label="Close" icon={<IconClose />} size="sm" onClick={() => onCloseRef.current()} style={headerActions !== undefined ? { marginLeft: 0 } : undefined} />
          )}
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
