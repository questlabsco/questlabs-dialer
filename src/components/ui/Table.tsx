import { useMemo, useState, type ReactNode } from 'react';
import { IconChevronDown, IconChevronUp, IconSort } from './icons';
import { Spinner } from './Spinner';

export interface TableColumn<T> {
  /** Unique column key. */
  key: string;
  header: ReactNode;
  /** Cell content. Default: String(row[key]). */
  render?: (row: T) => ReactNode;
  /** Makes the column sortable. Client-side: rows are sorted by this value. Controlled mode: only marks the column sortable. */
  sortValue?: (row: T) => string | number | null;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  /** Cut long content with an ellipsis (full text in a tooltip). */
  truncate?: boolean;
  /** Max cell width when truncating. Default 280px. */
  maxWidth?: number | string;
  /** Tooltip text for a cell. Default for truncated cells: the cell's text / sort value. */
  title?: (row: T) => string | undefined;
}

export type SortState = { key: string; dir: 'asc' | 'desc' } | null;

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Makes rows clickable and keyboard-activatable (Enter / Space). */
  onRowClick?: (row: T) => void;
  /** Highlighted row key. */
  selectedKey?: string | null;
  /** Shown when rows is empty. */
  empty?: ReactNode;
  dense?: boolean;
  /** Initial client-side sort. */
  defaultSort?: SortState;
  /**
   * Controlled sort (e.g. for server-side sorting). When `onSortChange` is given, rows are NOT
   * sorted locally; you sort them and pass `sort` back.
   */
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  /** Accessible caption (visually hidden). */
  caption?: string;
  /** Limit the table's height; the header stays sticky while its body scrolls. */
  maxHeight?: number | string;
  /** Shows a spinner instead of rows. */
  loading?: boolean;
  /** Extra class on the scroll container (.table-wrap). */
  className?: string;
}

function cellTitle<T>(c: TableColumn<T>, row: T, content: unknown): string | undefined {
  if (c.title) return c.title(row);
  if (!c.truncate) return undefined;
  if (typeof content === 'string' || typeof content === 'number') return String(content);
  const sv = c.sortValue?.(row);
  if (sv !== undefined && sv !== null) return String(sv);
  const raw = (row as Record<string, unknown>)[c.key];
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined;
}

/** Simple data table with optional sortable columns. */
export function Table<T>({ columns, rows, rowKey, onRowClick, selectedKey, empty, dense, defaultSort = null, sort, onSortChange, caption, maxHeight, loading, className }: TableProps<T>) {
  const [localSort, setLocalSort] = useState<SortState>(defaultSort);
  const controlled = onSortChange !== undefined;
  const activeSort = controlled ? sort ?? null : localSort;

  const sorted = useMemo(() => {
    if (controlled || !activeSort) return rows;
    const col = columns.find((c) => c.key === activeSort.key);
    if (!col?.sortValue) return rows;
    const dir = activeSort.dir === 'asc' ? 1 : -1;
    const get = col.sortValue;
    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av === bv) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, columns, activeSort, controlled]);

  const toggle = (key: string) => {
    const next: SortState = activeSort?.key === key ? (activeSort.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' };
    if (controlled) onSortChange!(next);
    else setLocalSort(next);
  };

  return (
    <div className={`table-wrap ${className ?? ''}`.trim()} style={maxHeight !== undefined ? { maxHeight } : undefined}>
      <table className={`table ${dense ? 'dense' : ''}`.trim()}>
        {caption && <caption className="visually-hidden">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => {
              const isSorted = activeSort?.key === c.key;
              const ariaSort = isSorted ? (activeSort!.dir === 'asc' ? 'ascending' : 'descending') : undefined;
              return (
                <th key={c.key} className={c.align ? `align-${c.align}` : undefined} style={c.width !== undefined ? { width: c.width } : undefined} aria-sort={ariaSort} scope="col">
                  {c.sortValue ? (
                    <button type="button" className="th-sort" onClick={() => toggle(c.key)}>
                      {c.header}
                      {isSorted ? activeSort!.dir === 'asc' ? <IconChevronUp size={12} /> : <IconChevronDown size={12} /> : <IconSort size={12} />}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr className="table-loading">
              <td colSpan={columns.length}>
                <Spinner size={20} label="Loading" />
              </td>
            </tr>
          ) : sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="table-empty">
                {empty ?? 'Nothing to show.'}
              </td>
            </tr>
          ) : (
            sorted.map((row) => {
              const key = rowKey(row);
              const cls = [onRowClick ? 'clickable' : '', selectedKey === key ? 'selected' : ''].filter(Boolean).join(' ') || undefined;
              return (
                <tr
                  key={key}
                  className={cls}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                  aria-selected={selectedKey !== undefined ? selectedKey === key : undefined}
                >
                  {columns.map((c) => {
                    const content = c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '');
                    const cls = [c.align ? `align-${c.align}` : '', c.truncate ? 'cell-truncate' : ''].filter(Boolean).join(' ') || undefined;
                    return (
                      <td key={c.key} className={cls} style={c.truncate && c.maxWidth !== undefined ? { maxWidth: c.maxWidth } : undefined} title={cellTitle(c, row, content)}>
                        {content}
                      </td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
