import { useEffect, useState } from 'react';
import Papa from 'papaparse';
import type { Tone } from '../../../components/ui';
import type { LeadStatus } from '../../../types';

export const STATUS_TONE: Record<LeadStatus, Tone> = {
  new: 'neutral',
  no_answer: 'neutral',
  callback: 'accent',
  booked: 'good',
  not_interested: 'neutral',
  wrong_number: 'warning',
  bad_number: 'warning',
  do_not_call: 'critical',
  exhausted: 'neutral',
};

/** Value that follows `value` after `ms` without changes. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Build a CSV with papaparse and hand it to the browser as a download. */
export function downloadCsv(fileName: string, fields: string[], data: (string | number)[][]): void {
  const csv = Papa.unparse({ fields, data });
  // BOM so Excel opens UTF-8 correctly.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "leads-2026-11-15.csv" style safe file names. */
export function safeFileName(base: string): string {
  return base.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'export';
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}
