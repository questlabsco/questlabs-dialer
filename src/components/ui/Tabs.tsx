import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  /** Optional trailing content, e.g. a count Badge. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Accessible name for the tab list. */
  label?: string;
  /** Prefix for tab/panel ids; panels can use id={`${idPrefix}-panel-${tab.id}`}. */
  idPrefix?: string;
  /** 'line' (default, underlined) or 'pills' (segmented control). */
  variant?: 'line' | 'pills';
}

/** Tab strip only (render the active panel yourself). Arrow keys / Home / End move between tabs. */
export function Tabs<T extends string = string>({ tabs, value, onChange, label, idPrefix = 'tabs', variant = 'line' }: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = tabs.filter((t) => !t.disabled);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = enabled.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % enabled.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + enabled.length) % enabled.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = enabled[next].id;
    onChange(id);
    refs.current[tabs.findIndex((t) => t.id === id)]?.focus();
  };

  return (
    <div className={variant === 'pills' ? 'tabs tabs-pills' : 'tabs'} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t, i) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            className="tab"
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.badge}
          </button>
        );
      })}
    </div>
  );
}
