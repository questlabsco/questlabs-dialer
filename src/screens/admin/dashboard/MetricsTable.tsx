/**
 * Sortable metrics table with an inline bar for the column being compared (the sorted
 * column, or the default one when sorting by name). Rows with no dials are de-emphasised.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Table, type SortState, type TableColumn } from '../../../components/ui';
import { maxOf, scaleFraction } from './chartMath';
import { TipRows, useTip } from './shared';

export interface MetricColumn<T> {
  key: string;
  header: string;
  value: (row: T) => number;
  format: (row: T) => string;
}

export interface MetricsTableProps<T> {
  rows: T[];
  rowKey: (row: T) => string;
  nameHeader: string;
  name: (row: T) => ReactNode;
  nameSort: (row: T) => string;
  /** Plain-text name for tooltips. */
  nameText: (row: T) => string;
  metrics: MetricColumn<T>[];
  /** Metric compared by the bar when the table is sorted by name. */
  defaultMetric: string;
  isZero: (row: T) => boolean;
  /** Extra columns appended after the metrics (e.g. status). */
  extra?: TableColumn<T>[];
  caption: string;
  empty?: ReactNode;
}

export function MetricsTable<T>({
  rows,
  rowKey,
  nameHeader,
  name,
  nameSort,
  nameText,
  metrics,
  defaultMetric,
  isZero,
  extra = [],
  caption,
  empty,
}: MetricsTableProps<T>) {
  const [sort, setSort] = useState<NonNullable<SortState>>({ key: defaultMetric, dir: 'desc' });
  const tip = useTip();

  const onSortChange = (next: SortState) => {
    // Table cycles asc -> desc -> off; we keep a sort at all times: a new column starts
    // descending (largest first, names A-Z), the same column flips direction.
    const key = next?.key ?? sort.key;
    if (key === sort.key) setSort({ key, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
    else setSort({ key, dir: key === 'name' ? 'asc' : 'desc' });
  };

  const compared = metrics.find((m) => m.key === sort.key) ?? metrics.find((m) => m.key === defaultMetric) ?? metrics[0];
  const max = maxOf(rows, compared.value);

  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    if (sort.key === 'name') return [...rows].sort((a, b) => nameSort(a).localeCompare(nameSort(b)) * dir);
    const m = metrics.find((x) => x.key === sort.key);
    const ex = extra.find((x) => x.key === sort.key)?.sortValue;
    const get = m ? m.value : ex ? (r: T) => Number(ex(r) ?? 0) : null;
    if (!get) return rows;
    return [...rows].sort((a, b) => (get(a) - get(b)) * dir || nameSort(a).localeCompare(nameSort(b)));
  }, [rows, sort, metrics, extra, nameSort]);

  const dim = (row: T, node: ReactNode) => (isZero(row) ? <span className="dz-zero">{node}</span> : node);

  const columns: TableColumn<T>[] = [
    { key: 'name', header: nameHeader, render: (r) => dim(r, name(r)), sortValue: (r) => nameSort(r) },
    ...metrics.map<TableColumn<T>>((m) => ({
      key: m.key,
      header: m.header,
      align: 'right',
      sortValue: m.value,
      render: (r) => {
        const text = <span className="num">{m.format(r)}</span>;
        if (m.key !== compared.key) return dim(r, text);
        // The compared column carries the inline bar (same baseline for every row), then the value.
        const f = scaleFraction(m.value(r), max);
        return (
          <span className="dz-cell-bar">
            <span
              className="dz-inline-bar"
              aria-hidden
              {...tip(<TipRows title={nameText(r)} rows={[{ value: m.format(r), label: m.header.toLowerCase() }]} />)}
            >
              {f > 0 && <span className="dz-inline-fill" style={{ width: `${f * 100}%` }} />}
            </span>
            {dim(r, text)}
          </span>
        );
      },
    })),
    ...extra,
  ];

  return (
    <div className="dz-scroll">
      <Table columns={columns} rows={sorted} rowKey={rowKey} sort={sort} onSortChange={onSortChange} dense caption={caption} empty={empty} />
    </div>
  );
}
