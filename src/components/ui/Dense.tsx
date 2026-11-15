/** Dense enterprise building blocks: metrics band, table toolbar, highlights strip, field grid, help tip. */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconArrowDown, IconArrowUp } from './icons';

// ---------------------------------------------------------------------------
// Metrics band: one panel split by hairlines; label, number, small delta.
// ---------------------------------------------------------------------------

export interface Metric {
  key?: string;
  label: ReactNode;
  value: ReactNode;
  /** Change line, e.g. <MetricDelta .../> plus "vs prev. 7 days". */
  sub?: ReactNode;
  /** Tooltip on the cell (definitions go here, not in the cell). */
  title?: string;
}

export interface MetricsBandProps extends HTMLAttributes<HTMLDivElement> {
  metrics: Metric[];
}

export function MetricsBand({ metrics, className, ...rest }: MetricsBandProps) {
  return (
    <div className={`metrics-band ${className ?? ''}`.trim()} {...rest}>
      {metrics.map((m, i) => (
        <div className="metric" key={m.key ?? i} title={m.title}>
          <div className="metric-label">{m.label}</div>
          <div className="metric-value">{m.value}</div>
          {m.sub !== undefined && <div className="metric-sub">{m.sub}</div>}
        </div>
      ))}
    </div>
  );
}

export interface MetricDeltaProps {
  /** Text such as "+12%" or "-0.4 pts". */
  text: ReactNode;
  tone: 'good' | 'bad' | 'flat';
  /** Direction of the arrow; omitted for flat. */
  direction?: 'up' | 'down';
}

/** Small coloured change with an arrow. */
export function MetricDelta({ text, tone, direction }: MetricDeltaProps) {
  return (
    <span className={`stat-delta ${tone === 'good' ? 'up' : tone === 'bad' ? 'down' : ''}`.trim()}>
      {tone !== 'flat' && direction === 'up' && <IconArrowUp size={11} strokeWidth={2.6} />}
      {tone !== 'flat' && direction === 'down' && <IconArrowDown size={11} strokeWidth={2.6} />}
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Toolbar: one slim row above a table (count at left, controls, actions at right).
// ---------------------------------------------------------------------------

export interface ToolbarProps extends HTMLAttributes<HTMLDivElement> {
  /** Record count at the left, e.g. "700 leads · 223 left to call". */
  count?: ReactNode;
  /** Right-aligned content. */
  right?: ReactNode;
  /** Tinted variant while rows are selected. */
  selected?: boolean;
}

export function Toolbar({ count, right, selected, className, children, ...rest }: ToolbarProps) {
  return (
    <div className={['toolbar', selected ? 'toolbar-selected' : '', className ?? ''].filter(Boolean).join(' ')} {...rest}>
      {count !== undefined && <span className="tb-count">{count}</span>}
      {children}
      {right !== undefined && <div className="tb-right">{right}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Highlights strip: key fields in a row, label over value.
// ---------------------------------------------------------------------------

export interface HighlightItem {
  key?: string;
  label: ReactNode;
  value: ReactNode;
  /** Tooltip for long values. */
  title?: string;
  /** Flex basis / grow behaviour. */
  style?: CSSProperties;
}

export function HighlightsStrip({ items, className }: { items: HighlightItem[]; className?: string }) {
  return (
    <dl className={`highlights ${className ?? ''}`.trim()}>
      {items.map((it, i) => (
        <div className="hl-item" key={it.key ?? i} style={it.style}>
          <dt className="hl-label">{it.label}</dt>
          <dd className="hl-value" title={it.title} style={{ margin: 0 }}>
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Field grid: read-only label/value pairs in 2 or 3 columns.
// ---------------------------------------------------------------------------

export function FieldGrid({ items, columns = 2, className }: { items: { key?: string; label: ReactNode; value: ReactNode }[]; columns?: number; className?: string }) {
  return (
    <dl className={`field-grid ${className ?? ''}`.trim()} style={{ '--fg-cols': columns } as CSSProperties}>
      {items.map((it, i) => (
        <div className="fg-item" key={it.key ?? i}>
          <dt>{it.label}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Help tip: the small "i" with the explanation in a tooltip.
// ---------------------------------------------------------------------------

const HELP_POP_WIDTH = 260;
const HELP_POP_MARGIN = 8;

/**
 * Small "i" that explains a setting. The explanation opens in our own popover on hover, focus or
 * click: the operating system's native tooltip does not appear in the desktop window.
 */
export function HelpTip({ text }: { text: string }) {
  const id = useId();
  const anchor = useRef<HTMLElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);

  const open = useCallback(() => {
    const el = anchor.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const half = HELP_POP_WIDTH / 2;
    const centre = r.left + r.width / 2;
    const left = Math.min(Math.max(centre - half, HELP_POP_MARGIN), Math.max(HELP_POP_MARGIN, window.innerWidth - HELP_POP_WIDTH - HELP_POP_MARGIN));
    // Open below unless there is too little room; then open above.
    const above = r.bottom + 120 > window.innerHeight;
    setPos({ left, top: above ? r.top - 6 : r.bottom + 6, above });
  }, []);
  const close = useCallback(() => setPos(null), []);

  useEffect(() => {
    if (!pos) return;
    // Any scroll or resize would leave the popover pointing at the wrong place.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos, close]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && pos) {
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (pos) close();
      else open();
    }
  };

  return (
    <>
      <i
        ref={anchor}
        className="help-tip"
        role="button"
        tabIndex={0}
        aria-label={text}
        aria-describedby={pos ? id : undefined}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        onClick={(e) => {
          // Inside a label or a sortable header, a click must only show the help.
          e.preventDefault();
          e.stopPropagation();
          open();
        }}
        onKeyDown={onKeyDown}
      >
        i
      </i>
      {pos &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className={pos.above ? 'help-pop help-pop-above' : 'help-pop'}
            style={{ left: pos.left, top: pos.top, width: HELP_POP_WIDTH }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Section heading with a hairline rule and optional right-side actions. */
export function SectionHeading({ children, actions, as: Tag = 'h2', id }: { children: ReactNode; actions?: ReactNode; as?: 'h2' | 'h3'; id?: string }) {
  return (
    <Tag className="section-heading" id={id}>
      {children}
      {actions !== undefined && <span className="actions">{actions}</span>}
    </Tag>
  );
}
