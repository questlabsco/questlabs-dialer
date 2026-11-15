/**
 * Small shared pieces for the dashboard: element-width hook, a floating tooltip layer
 * (position: fixed so it escapes scrolling table containers), and the chart card with its
 * chart / table toggle.
 */
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button, Card } from '../../../components/ui';
import { placeTooltip } from './chartMath';

// ---------------------------------------------------------------------------
// Width of an element, kept fresh with ResizeObserver.
// ---------------------------------------------------------------------------

export function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    observer.current = ro;
  }, []);
  return [ref, width];
}

// ---------------------------------------------------------------------------
// Floating tooltip layer
// ---------------------------------------------------------------------------

interface TipState {
  rect: DOMRect;
  content: ReactNode;
}

interface TipApi {
  show: (el: Element, content: ReactNode) => void;
  hide: () => void;
}

const TipContext = createContext<TipApi>({ show: () => undefined, hide: () => undefined });

export function TipLayer({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<TipState | null>(null);
  const api = useMemo<TipApi>(
    () => ({
      show: (el, content) => setTip({ rect: el.getBoundingClientRect(), content }),
      hide: () => setTip(null),
    }),
    [],
  );
  return (
    <TipContext.Provider value={api}>
      {children}
      {tip && <FloatingTip tip={tip} />}
    </TipContext.Provider>
  );
}

function FloatingTip({ tip }: { tip: TipState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const left = placeTooltip(tip.rect.right, w, vw, 8);
    // Above the mark when there is room, otherwise below it.
    const above = tip.rect.top - h - 6;
    const top = above >= 4 ? above : Math.min(window.innerHeight - h - 4, tip.rect.bottom + 6);
    setPos({ left, top });
  }, [tip]);
  return (
    <div
      ref={ref}
      className="dz-tooltip dz-tooltip-fixed"
      role="tooltip"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {tip.content}
    </div>
  );
}

/** Props to spread on a mark so hover and keyboard focus show `content` in the tooltip layer. */
export function useTip() {
  const api = useContext(TipContext);
  return useCallback(
    (content: ReactNode) => ({
      onPointerEnter: (e: { currentTarget: Element }) => api.show(e.currentTarget, content),
      onPointerLeave: () => api.hide(),
      onFocus: (e: { currentTarget: Element }) => api.show(e.currentTarget, content),
      onBlur: () => api.hide(),
    }),
    [api],
  );
}

/** Tooltip body: value first (strong), label after (secondary). */
export function TipRows({ title, rows }: { title?: ReactNode; rows: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <>
      {title !== undefined && <div className="dz-tip-title">{title}</div>}
      {rows.map((r, i) => (
        <div className="dz-tip-row" key={i}>
          <span className="dz-tip-value">{r.value}</span>
          <span className="dz-tip-label">{r.label}</span>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Chart card with chart / table toggle
// ---------------------------------------------------------------------------

export function ChartCard({
  id,
  title,
  subtitle,
  table,
  children,
  toggle = true,
  className,
}: {
  id?: string;
  /** Extra class on the panel (layout placement). */
  className?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** The chart's table-view twin. */
  table: ReactNode;
  children: ReactNode;
  /** Hide the toggle (e.g. when there is nothing to chart). */
  toggle?: boolean;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <Card
      id={id}
      className={`dz-card ${className ?? ''}`.trim()}
      title={title}
      subtitle={subtitle}
      actions={
        toggle ? (
          <Button size="sm" variant="ghost" aria-pressed={showTable} onClick={() => setShowTable((v) => !v)}>
            {showTable ? 'Show chart' : 'Show table'}
          </Button>
        ) : undefined
      }
    >
      {toggle && showTable ? table : children}
    </Card>
  );
}
