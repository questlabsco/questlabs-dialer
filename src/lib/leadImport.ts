/**
 * Adaptive lead import: pure functions that turn an arbitrary spreadsheet (CSV / TSV / text, or
 * cells pasted from Excel / Google Sheets) into `NewLead` rows.
 *
 * Pipeline:
 *   parseSheetText()  -> string[][] grid (BOM, blank lines and ragged rows handled)
 *   detectHeader()    -> does row 1 hold column names?
 *   buildColumns()    -> one SourceColumn per column (header, samples, content stats)
 *   guessMappings()   -> a target + confidence for every column (header text AND cell contents)
 *   setColumnTarget() -> admin corrections (keeps single-use targets unique)
 *   prepareRows()     -> one PreparedRow per data row: ready / invalid / duplicate + the NewLead
 *
 * `analyzeSheet()` runs the first four steps in one go.
 */
import Papa from 'papaparse';
import { normalizePhone } from './format';
import type { NewLead } from '../types';

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export type ImportTarget =
  | 'businessName'
  | 'contactName'
  | 'firstName'
  | 'lastName'
  | 'phone1'
  | 'phone2'
  | 'phone3'
  | 'phone4'
  | 'phone5'
  | 'email'
  | 'city'
  | 'state'
  | 'notes'
  | 'ignore';

export const PHONE_TARGETS = ['phone1', 'phone2', 'phone3', 'phone4', 'phone5'] as const;
export type PhoneTarget = (typeof PHONE_TARGETS)[number];

export const IMPORT_TARGETS: readonly { value: ImportTarget; label: string }[] = [
  { value: 'businessName', label: 'Business name' },
  { value: 'contactName', label: 'Contact name (full)' },
  { value: 'firstName', label: 'Contact first name' },
  { value: 'lastName', label: 'Contact last name' },
  { value: 'phone1', label: 'Phone 1 (tried first)' },
  { value: 'phone2', label: 'Phone 2' },
  { value: 'phone3', label: 'Phone 3' },
  { value: 'phone4', label: 'Phone 4 (backup)' },
  { value: 'phone5', label: 'Phone 5 (backup)' },
  { value: 'email', label: 'Email' },
  { value: 'city', label: 'City' },
  { value: 'state', label: 'State' },
  { value: 'notes', label: 'Notes' },
  { value: 'ignore', label: "Don't import" },
];

export function importTargetLabel(t: ImportTarget): string {
  return IMPORT_TARGETS.find((x) => x.value === t)?.label ?? t;
}

export function isPhoneTarget(t: ImportTarget): t is PhoneTarget {
  return (PHONE_TARGETS as readonly string[]).includes(t);
}

/** Targets that several columns may share. All others are used by at most one column. */
const MULTI_TARGETS: ReadonlySet<ImportTarget> = new Set(['notes', 'ignore']);

/** Below this a mapping is shown as a weak guess. */
export const WEAK_CONFIDENCE = 0.7;

/** Most numbers a lead can hold. */
export const MAX_PHONES = 3;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** File extensions we cannot read without a spreadsheet library. */
export function isUnsupportedSpreadsheet(fileName: string): boolean {
  return /\.(xlsx|xlsm|xlsb|xls|ods|numbers)$/i.test(fileName.trim());
}

export const UNSUPPORTED_SPREADSHEET_MESSAGE =
  'Excel files can’t be read directly. In Excel or Google Sheets choose File → Save As (or Download) → CSV and upload that file, or select the cells, copy them and paste them into the box below.';

/** True if the file name looks like something we can parse. */
export function isSupportedTextFile(fileName: string): boolean {
  return /\.(csv|tsv|txt|tab)$/i.test(fileName.trim());
}

/**
 * Parse delimited text into a rectangular grid of trimmed strings.
 * - strips a UTF-8 BOM, skips blank lines, pads ragged rows, drops trailing empty columns;
 * - delimiter is auto-detected, except text containing tabs (pasted cells) which is split on tabs.
 */
export function parseSheetText(text: string, opts: { delimiter?: string } = {}): string[][] {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!clean.trim()) return [];
  const firstLine = clean.split('\n').find((l) => l.trim() !== '') ?? '';
  const delimiter = opts.delimiter ?? (firstLine.includes('\t') ? '\t' : undefined);
  const result = Papa.parse<string[]>(clean, {
    header: false,
    skipEmptyLines: 'greedy',
    delimiter: delimiter ?? '',
    delimitersToGuess: [',', '\t', ';', '|'],
  });
  const raw = (result.data as unknown[]).filter(Array.isArray) as unknown[][];
  let rows = raw.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c).replace(/^﻿/, '').trim())));
  rows = rows.filter((r) => r.some((c) => c !== ''));
  if (rows.length === 0) return [];
  // Width = last column that has any value.
  let width = 0;
  for (const r of rows) {
    for (let i = r.length - 1; i >= 0; i--) {
      if (r[i] !== '') {
        width = Math.max(width, i + 1);
        break;
      }
    }
  }
  return rows.map((r) => {
    const out = r.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });
}

/** Spreadsheet-style column letter: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** "Leads - Dallas (3).csv" -> "Leads - Dallas (3)". */
export function listNameFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').trim();
  return base || 'Imported leads';
}

// ---------------------------------------------------------------------------
// Value classifiers
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[a-z]{2,}$/i;

export function looksLikeEmail(v: string): boolean {
  return EMAIL_RE.test(v.trim());
}

/** First email address in a cell (cells sometimes hold several), or ''. */
export function extractEmail(v: string): string {
  for (const part of v.split(/[\s,;]+/)) {
    const p = part.replace(/^mailto:/i, '').replace(/^[<(]+|[>)]+$/g, '');
    if (looksLikeEmail(p)) return p;
  }
  return '';
}

export const US_STATES: Readonly<Record<string, string>> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const STATE_BY_NAME: ReadonlyMap<string, string> = new Map([
  ...Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase().replace(/[^a-z]/g, ''), code] as [string, string]),
  ['washingtondc', 'DC'],
  ['tex', 'TX'],
  ['calif', 'CA'],
  ['fla', 'FL'],
  ['okla', 'OK'],
  ['ariz', 'AZ'],
]);

/** "Texas" / "tx" / "TX " / "Tex." -> "TX"; anything unrecognised -> ''. */
export function normalizeState(v: string): string {
  const t = v.trim();
  if (!t) return '';
  const up = t.toUpperCase().replace(/\./g, '');
  if (up.length === 2 && US_STATES[up]) return up;
  return STATE_BY_NAME.get(t.toLowerCase().replace(/[^a-z]/g, '')) ?? '';
}

const KNOWN_CITIES = new Set(
  [
    // Dallas–Fort Worth
    'dallas', 'fort worth', 'ft worth', 'arlington', 'plano', 'irving', 'garland', 'frisco', 'mckinney',
    'grand prairie', 'denton', 'mesquite', 'carrollton', 'richardson', 'lewisville', 'allen', 'flower mound',
    'north richland hills', 'mansfield', 'rowlett', 'euless', 'desoto', 'grapevine', 'bedford', 'cedar hill',
    'haltom city', 'wylie', 'keller', 'coppell', 'rockwall', 'burleson', 'the colony', 'hurst', 'little elm',
    'duncanville', 'lancaster', 'southlake', 'prosper', 'addison', 'farmers branch', 'university park',
    'highland park', 'colleyville', 'waxahachie', 'weatherford', 'celina', 'forney', 'sachse', 'murphy',
    'midlothian', 'saginaw', 'watauga', 'balch springs', 'benbrook', 'trophy club', 'roanoke', 'anna',
    'princeton', 'melissa', 'aubrey', 'argyle', 'corinth', 'highland village', 'lake dallas', 'seagoville',
    'glenn heights', 'red oak', 'crowley', 'azle', 'granbury', 'cleburne', 'sherman', 'denison', 'terrell',
    // Other large US / Texas cities
    'houston', 'san antonio', 'austin', 'el paso', 'corpus christi', 'lubbock', 'laredo', 'amarillo', 'waco',
    'tyler', 'killeen', 'round rock', 'new york', 'los angeles', 'chicago', 'phoenix', 'philadelphia',
    'san diego', 'san jose', 'jacksonville', 'columbus', 'charlotte', 'indianapolis', 'seattle', 'denver',
    'washington', 'boston', 'nashville', 'detroit', 'oklahoma city', 'portland', 'las vegas', 'memphis',
    'louisville', 'baltimore', 'milwaukee', 'albuquerque', 'tucson', 'fresno', 'sacramento', 'atlanta',
    'miami', 'tulsa', 'tampa', 'orlando', 'new orleans', 'minneapolis', 'kansas city', 'omaha', 'raleigh',
  ],
);

function isKnownCity(v: string): boolean {
  return KNOWN_CITIES.has(v.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' '));
}

const BUSINESS_WORDS =
  /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|ltd|lp|llp|pllc|pc|group|services?|solutions|enterprises?|holdings|partners|associates|plumbing|roofing|hvac|electric(al)?|construction|contractors?|landscaping|lawn|cleaning|auto|automotive|repair|restaurant|grill|cafe|bakery|salon|spa|dental|dentistry|clinic|medical|law|legal|firm|realty|real estate|insurance|agency|studio|fitness|gym|pest|painting|remodeling|builders?|supply|motors|logistics|transport|trucking|consulting|marketing|design|church|academy|school|store|shop|market|bar|pub|pizza|tacos?|bbq|kitchen|wellness|pharmacy|vet|veterinary|animal|pet|garage|tire|towing|moving|movers|storage|homes|properties|management|capital|financial|cpa|accounting|tax)\b|&/i;

function looksLikeBusiness(v: string): boolean {
  return BUSINESS_WORDS.test(v);
}

function looksLikePersonName(v: string): boolean {
  const t = v.trim();
  if (!t || t.length > 40 || /\d|@/.test(t) || looksLikeBusiness(t)) return false;
  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((w) => /^[A-Z][a-zA-Z'\-.]*$/.test(w));
}

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------

/** Remove a trailing extension: "x123", "ext. 4", "ext: 12", "extension 9", "#55". */
export function stripExtension(v: string): string {
  return v.replace(/\s*(?:,|;)?\s*(?:x|ext|extn|extension|#)\s*[.:]?\s*\d{1,6}\s*$/i, '').trim();
}

export type PhoneCheck = { ok: true; e164: string } | { ok: false; reason: 'international' | 'invalid' };

/** One candidate number -> US E.164, or why not. */
export function checkUsPhone(raw: string): PhoneCheck {
  let v = stripExtension(raw.trim());
  // Excel sometimes turns numbers into "2145550123.0".
  if (/^\d+\.0+$/.test(v)) v = v.replace(/\.0+$/, '');
  if (!/\d/.test(v)) return { ok: false, reason: 'invalid' };
  const n = normalizePhone(v);
  if (!n) {
    const digits = v.replace(/\D/g, '');
    if ((v.startsWith('+') || v.startsWith('00')) && !digits.replace(/^00/, '').startsWith('1')) return { ok: false, reason: 'international' };
    return { ok: false, reason: 'invalid' };
  }
  if (!/^\+1\d{10}$/.test(n)) return { ok: false, reason: 'international' };
  return { ok: true, e164: n };
}

/**
 * All numbers held in one cell, in order. Cells may hold several numbers separated by
 * "/", ";", ",", "|", newlines or the word "or". Returns valid E.164 numbers plus the
 * pieces that could not be used.
 */
export function splitPhoneCell(cell: string): { phones: string[]; rejected: { value: string; reason: 'international' | 'invalid' }[] } {
  // Drop extensions anywhere in the cell ("214-555-0123 x12 / 972-555-0100 ext. 4").
  const value = cell.replace(/[,;]?\s*(?:x|ext|extn|extension|#)\s*[.:]?\s*\d{1,6}(?=\s*(?:$|[/;,|\n]|\bor\b))/gi, '').trim();
  if (!value) return { phones: [], rejected: [] };
  const parts = value
    .split(/\s*(?:[/;,|\n]|\bor\b|\band\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const phones: string[] = [];
  const rejected: { value: string; reason: 'international' | 'invalid' }[] = [];
  for (const p of parts) {
    const c = checkUsPhone(p);
    if (c.ok) {
      if (!phones.includes(c.e164)) phones.push(c.e164);
    } else rejected.push({ value: p, reason: c.reason });
  }
  if (phones.length === 0 && parts.length > 1) {
    // "214/555-0123" style: the separator was part of one number.
    const whole = checkUsPhone(value);
    if (whole.ok) return { phones: [whole.e164], rejected: [] };
  }
  return { phones, rejected };
}

function cellHasPhone(v: string): boolean {
  return v.replace(/\D/g, '').length >= 10 && splitPhoneCell(v).phones.length > 0;
}

/** Phone-looking text (10+ digits mostly made of phone characters), valid or not. */
function looksPhoneish(v: string): boolean {
  const digits = v.replace(/\D/g, '');
  if (digits.length < 10) return false;
  return /^[\d\s()+\-./x#,;:|]*$/i.test(stripExtension(v).replace(/ext|extension/gi, ''));
}

// ---------------------------------------------------------------------------
// Header detection & columns
// ---------------------------------------------------------------------------

function normHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const HEADER_HINT_WORDS = new Set([
  'name', 'company', 'business', 'phone', 'mobile', 'cell', 'email', 'mail', 'city', 'state', 'zip', 'address',
  'notes', 'note', 'contact', 'owner', 'first', 'last', 'title', 'website', 'organization', 'account', 'number',
  'direct', 'tel', 'telephone', 'region', 'province', 'comments', 'description', 'industry', 'dba', 'fax', 'street',
  'country', 'url', 'linkedin', 'employees', 'revenue', 'status', 'type', 'id',
]);

/**
 * Decide from content whether the first row holds column names: a header row has no phone- or
 * email-like values while the rows below do, or it is made of typical column words.
 */
export function detectHeader(grid: string[][]): boolean {
  if (grid.length === 0) return false;
  const first = grid[0];
  const dataLike = (v: string) => looksPhoneish(v) || looksLikeEmail(v) || cellHasPhone(v);
  const firstHits = first.filter(dataLike).length;
  if (firstHits > 0) return false;
  const rest = grid.slice(1, 26);
  const restHits = rest.filter((r) => r.some(dataLike)).length;
  if (rest.length > 0 && restHits / rest.length >= 0.3) return true;
  const hintCells = first.filter((c) => normHeader(c).split(' ').some((w) => HEADER_HINT_WORDS.has(w))).length;
  if (hintCells > 0) return true;
  // No signal either way: a header row is usually more "texty" than numbers.
  return grid.length > 1 && !first.some((c) => /^\d[\d\s,.-]*$/.test(c));
}

export interface ColumnStats {
  nonEmpty: number;
  phoneShare: number;
  emailShare: number;
  stateShare: number;
  cityShare: number;
  businessShare: number;
  personShare: number;
  numericShare: number;
  avgLength: number;
}

export interface SourceColumn {
  index: number;
  /** "A", "B", … */
  letter: string;
  /** Header text, or "Column A" for header-less sheets / blank header cells. */
  header: string;
  /** True when `header` came from the file. */
  hasHeaderText: boolean;
  /** Up to 3 non-empty sample values. */
  samples: string[];
  stats: ColumnStats;
}

function columnStats(values: string[]): ColumnStats {
  const vals = values.filter((v) => v !== '');
  const n = vals.length;
  if (n === 0) {
    return { nonEmpty: 0, phoneShare: 0, emailShare: 0, stateShare: 0, cityShare: 0, businessShare: 0, personShare: 0, numericShare: 0, avgLength: 0 };
  }
  let phone = 0, email = 0, state = 0, city = 0, business = 0, person = 0, numeric = 0, len = 0;
  for (const v of vals) {
    len += v.length;
    if (cellHasPhone(v)) phone++;
    if (extractEmail(v)) email++;
    if (normalizeState(v)) state++;
    if (isKnownCity(v)) city++;
    if (looksLikeBusiness(v)) business++;
    if (looksLikePersonName(v)) person++;
    if (/^[\d\s,.$%+-]+$/.test(v)) numeric++;
  }
  return {
    nonEmpty: n,
    phoneShare: phone / n,
    emailShare: email / n,
    stateShare: state / n,
    cityShare: city / n,
    businessShare: business / n,
    personShare: person / n,
    numericShare: numeric / n,
    avgLength: len / n,
  };
}

/** How many data rows are inspected for content stats. */
const STATS_ROWS = 300;

export function buildColumns(grid: string[][], hasHeader: boolean): SourceColumn[] {
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const data = hasHeader ? grid.slice(1) : grid;
  const sample = data.slice(0, STATS_ROWS);
  const cols: SourceColumn[] = [];
  for (let i = 0; i < width; i++) {
    const letter = columnLetter(i);
    const headerCell = hasHeader ? (grid[0]?.[i] ?? '').trim() : '';
    const values = sample.map((r) => (r[i] ?? '').trim());
    cols.push({
      index: i,
      letter,
      header: headerCell || `Column ${letter}`,
      hasHeaderText: !!headerCell,
      samples: data
        .map((r) => (r[i] ?? '').trim())
        .filter(Boolean)
        .slice(0, 3),
      stats: columnStats(values),
    });
  }
  return cols;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export interface ColumnMapping {
  index: number;
  target: ImportTarget;
  /** 0..1. Below WEAK_CONFIDENCE the UI flags the guess. */
  confidence: number;
  /** Short plain-English reason for the guess. */
  reason: string;
  /** For "don't import" columns: append "Header: value" to the lead's notes. */
  keepAsExtra: boolean;
}

type Field = 'businessName' | 'contactName' | 'firstName' | 'lastName' | 'phone' | 'email' | 'city' | 'state' | 'notes';

interface HeaderGuess {
  field: Field | null;
  score: number;
  /** Lower = dialed earlier (phones only). */
  phoneRank?: number;
  /** Useful context worth keeping in notes by default. */
  keepExtra?: boolean;
  /** The header names something we don't import: content-based guesses are capped at this. */
  contentCap?: number;
}

const has = (words: string[], ...ws: string[]) => ws.some((w) => words.includes(w));

/** Rank among several phone columns: mobile / cell / direct first, company / HQ last. */
export function phoneRankFromHeader(header: string): number {
  const w = normHeader(header).split(' ');
  if (has(w, 'mobile', 'cell', 'cellular', 'cellphone', 'personal', 'owner', 'wireless', 'sms', 'text')) return 0;
  if (has(w, 'direct', 'dial')) return 1;
  if (has(w, 'company', 'corporate', 'hq', 'headquarters', 'main', 'switchboard', 'office', 'business', 'organization', 'account', 'front', 'desk', 'store')) return 5;
  if (has(w, 'work')) return 4;
  if (has(w, 'home', 'other', 'alternate', 'alt', 'secondary', 'additional', 'landline')) return 3;
  const num = /(\d+)/.exec(normHeader(header));
  if (num) return 2 + Math.min(3, Math.max(0, Number(num[1]) - 1)) * 0.25;
  return 2;
}

function guessFromHeader(header: string): HeaderGuess {
  const h = normHeader(header);
  if (!h) return { field: null, score: 0 };
  const w = h.split(' ');
  // Never phones / not lead data.
  if (has(w, 'fax')) return { field: null, score: 0, contentCap: 0.3 };
  // "categoryName", "Business Category", "Niche", "Rating", "reviewsCount", "Opening hours" (map-scraper
  // exports) describe the business; they are never its name, even when the values read like one.
  if (/categor|niche|sector|vertical|rating|review|hours/.test(h)) {
    return { field: null, score: 0, keepExtra: /categor|niche|sector|vertical/.test(h), contentCap: 0.3 };
  }
  if (/\b(account|contact|lead|record|deal) owner\b/.test(h)) return { field: null, score: 0, contentCap: 0.3 };
  if (has(w, 'status', 'confidence', 'verified', 'valid', 'type', 'source', 'count', 'date', 'id', 'score', 'stage') && !has(w, 'state')) {
    // "Email Status", "Phone Type", "Lead Source" … describe a value; they are not the value.
    return { field: null, score: 0, contentCap: 0.3 };
  }
  // "Company Name", "Company Name for Emails" (Apollo), "Business Name".
  if (has(w, 'company', 'business', 'organization', 'organisation') && has(w, 'name') && !has(w, 'phone', 'owner', 'contact')) {
    return { field: 'businessName', score: /^(company|business|organization|organisation) name$/.test(h) ? 0.96 : 0.8 };
  }
  if (has(w, 'email', 'emails') || /\be mail\b/.test(h)) {
    return { field: 'email', score: h === 'email' || h === 'email address' || h === 'work email' ? 0.97 : 0.9 };
  }
  if (has(w, 'phone', 'phones', 'mobile', 'cell', 'cellphone', 'tel', 'telephone', 'ph', 'whatsapp', 'landline') || /\b(direct|dial|contact) (number|line|no)\b/.test(h) || h === 'number' || h === 'direct' || h === 'phone number') {
    return { field: 'phone', score: 0.92, phoneRank: phoneRankFromHeader(header) };
  }
  if (/^(first|first name|firstname|fname|given name|forename|owner first name|contact first name)$/.test(h) || (has(w, 'first') && has(w, 'name'))) {
    return { field: 'firstName', score: 0.95 };
  }
  if (/^(last|last name|lastname|lname|surname|family name|owner last name|contact last name)$/.test(h) || (has(w, 'last', 'surname') && has(w, 'name', 'surname'))) {
    return { field: 'lastName', score: 0.95 };
  }
  if (has(w, 'city', 'town', 'locality', 'municipality')) return { field: 'city', score: 0.94 };
  if (has(w, 'state', 'region', 'province', 'st') && !has(w, 'street', 'estate')) return { field: 'state', score: has(w, 'state') ? 0.94 : 0.85 };
  if (has(w, 'notes', 'note', 'comments', 'comment', 'description', 'remarks', 'memo', 'details', 'about', 'summary', 'bio')) {
    return { field: 'notes', score: 0.85 };
  }
  const notBusiness = has(
    w, 'address', 'street', 'website', 'url', 'domain', 'linkedin', 'facebook', 'twitter', 'size', 'industry',
    'revenue', 'employees', 'zip', 'postal', 'postcode', 'country', 'keywords', 'founded', 'sic', 'naics', 'code',
  );
  // A bare "title" is a job title in contact exports (Owner, Founder) but the business's name in
  // map-scraper exports, so let the cell contents decide instead of ruling it out.
  if (h === 'title') return { field: null, score: 0, keepExtra: true };
  if (has(w, 'title', 'website', 'industry', 'url', 'domain') && !has(w, 'name')) return { field: null, score: 0, keepExtra: true, contentCap: 0.3 };
  if (notBusiness) return { field: null, score: 0, contentCap: 0.3 };
  if (!notBusiness && (has(w, 'owner', 'contact', 'person', 'decision', 'principal', 'representative', 'rep', 'proprietor') || /^(full name|name|person name|customer name|client name|lead name|prospect name)$/.test(h))) {
    if (h === 'name') return { field: 'contactName', score: 0.6 };
    if (has(w, 'contact', 'owner', 'person', 'full', 'decision', 'principal', 'proprietor')) return { field: 'contactName', score: 0.9 };
    return { field: 'contactName', score: 0.75 };
  }
  if (!notBusiness && /^(company|company name|business|business name|organization|organisation|organization name|organisation name|org|org name|account|account name|dba|doing business as|firm|firm name|employer|legal name|company legal name|merchant|merchant name|brand|store|store name|shop|practice|practice name|establishment|vendor|client|customer)$/.test(h)) {
    return { field: 'businessName', score: 0.95 };
  }
  if (!notBusiness && has(w, 'company', 'business', 'organization', 'organisation', 'dba', 'firm', 'employer', 'merchant')) {
    return { field: 'businessName', score: 0.8 };
  }
  if (!notBusiness && has(w, 'name')) return { field: 'contactName', score: 0.5 };
  return { field: null, score: 0 };
}

interface Candidate {
  index: number;
  field: Field;
  score: number;
  reason: string;
  phoneRank: number;
}

function contentCandidates(col: SourceColumn): Candidate[] {
  const s = col.stats;
  const out: Candidate[] = [];
  if (s.nonEmpty === 0) return out;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (s.phoneShare >= 0.4) out.push({ index: col.index, field: 'phone', score: 0.5 + 0.4 * s.phoneShare, reason: `${pct(s.phoneShare)} of values look like phone numbers`, phoneRank: 2.5 });
  if (s.emailShare >= 0.4) out.push({ index: col.index, field: 'email', score: 0.55 + 0.4 * s.emailShare, reason: `${pct(s.emailShare)} of values look like emails`, phoneRank: 9 });
  if (s.stateShare >= 0.7 && s.avgLength <= 16) out.push({ index: col.index, field: 'state', score: 0.45 + 0.4 * s.stateShare, reason: `${pct(s.stateShare)} of values are US states`, phoneRank: 9 });
  if (s.cityShare >= 0.4) out.push({ index: col.index, field: 'city', score: 0.4 + 0.4 * s.cityShare, reason: `${pct(s.cityShare)} of values are known city names`, phoneRank: 9 });
  if (s.businessShare >= 0.3 && s.phoneShare < 0.2 && s.emailShare < 0.2) out.push({ index: col.index, field: 'businessName', score: 0.4 + 0.4 * s.businessShare, reason: `${pct(s.businessShare)} of values look like business names`, phoneRank: 9 });
  if (s.personShare >= 0.6 && s.businessShare < 0.2) out.push({ index: col.index, field: 'contactName', score: 0.35 + 0.3 * s.personShare, reason: `values look like people's names`, phoneRank: 9 });
  if (s.avgLength >= 40 && s.phoneShare < 0.2 && s.emailShare < 0.2 && s.numericShare < 0.2) out.push({ index: col.index, field: 'notes', score: 0.45, reason: 'long free text', phoneRank: 9 });
  return out;
}

/** How well a column's contents support a header-based guess (1 = fine, lower = contradicts). */
function contentAgreement(field: Field, s: ColumnStats): number {
  if (s.nonEmpty < 3) return 1;
  switch (field) {
    case 'phone':
      return s.phoneShare >= 0.5 ? 1.05 : s.phoneShare >= 0.15 ? 0.9 : 0.45;
    case 'email':
      return s.emailShare >= 0.5 ? 1.03 : s.emailShare >= 0.15 ? 0.85 : 0.45;
    case 'state':
      return s.stateShare >= 0.6 ? 1.03 : s.stateShare >= 0.3 ? 0.85 : 0.55;
    case 'businessName':
    case 'contactName':
    case 'firstName':
    case 'lastName':
    case 'city':
      return s.phoneShare > 0.5 || s.emailShare > 0.5 || s.numericShare > 0.7 ? 0.4 : 1;
    default:
      return 1;
  }
}

/** Guess a target for every column. Single-use targets are given to the strongest column. */
export function guessMappings(columns: SourceColumn[]): ColumnMapping[] {
  const candidates: Candidate[] = [];
  const keepExtra = new Map<number, boolean>();
  for (const col of columns) {
    if (col.stats.nonEmpty === 0) continue;
    const hg: HeaderGuess = col.hasHeaderText ? guessFromHeader(col.header) : { field: null, score: 0 };
    if (hg.keepExtra) keepExtra.set(col.index, true);
    if (hg.field) {
      const agree = contentAgreement(hg.field, col.stats);
      candidates.push({
        index: col.index,
        field: hg.field,
        score: Math.min(0.99, hg.score * agree),
        reason: agree < 0.8 ? `header says "${col.header}" but the values don't look like it` : `header "${col.header}"`,
        phoneRank: hg.phoneRank ?? 2,
      });
    }
    for (const c of contentCandidates(col)) {
      // A content guess only matters when the header said nothing or something weaker.
      if (hg.field === c.field) continue;
      const cap = hg.field ? 0.65 : hg.contentCap ?? 1;
      candidates.push({ ...c, score: Math.min(c.score, cap) });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);

  const chosen = new Map<number, Candidate>();
  const usedFields = new Map<Field, number>();
  const limit = (f: Field) => (f === 'phone' ? PHONE_TARGETS.length : f === 'notes' ? Infinity : 1);
  for (const c of candidates) {
    if (c.score < 0.35) continue;
    if (chosen.has(c.index)) continue;
    const used = usedFields.get(c.field) ?? 0;
    if (used >= limit(c.field)) continue;
    chosen.set(c.index, c);
    usedFields.set(c.field, used + 1);
  }

  // Full name beats first + last; if both exist, first / last are not imported separately.
  const hasFull = [...chosen.values()].some((c) => c.field === 'contactName' && c.score >= 0.7);
  const hasFirstLast = [...chosen.values()].some((c) => c.field === 'firstName' || c.field === 'lastName');
  if (hasFirstLast && !hasFull) {
    // A weak full-name guess must not hide real first / last name columns.
    for (const [i, c] of chosen) if (c.field === 'contactName') chosen.delete(i);
  }
  if (hasFull) {
    for (const [i, c] of chosen) if (c.field === 'firstName' || c.field === 'lastName') chosen.delete(i);
  }

  // No name column found at all: offer the leftmost plain-text column as a (weak) business name.
  const nameFields: Field[] = ['businessName', 'contactName', 'firstName', 'lastName'];
  if (![...chosen.values()].some((c) => nameFields.includes(c.field))) {
    const fallback = columns.find((col) => {
      if (chosen.has(col.index) || col.stats.nonEmpty === 0) return false;
      const hg: HeaderGuess = col.hasHeaderText ? guessFromHeader(col.header) : { field: null, score: 0 };
      if (hg.contentCap !== undefined) return false;
      const s = col.stats;
      return s.numericShare < 0.2 && s.phoneShare < 0.1 && s.emailShare < 0.1 && s.stateShare < 0.5 && s.avgLength >= 3 && s.avgLength <= 60;
    });
    if (fallback) chosen.set(fallback.index, { index: fallback.index, field: 'businessName', score: 0.4, reason: 'first text column (best guess)', phoneRank: 9 });
  }

  // Order phone columns: header rank, then fuller columns, then position.
  const phoneCols = [...chosen.values()]
    .filter((c) => c.field === 'phone')
    .sort((a, b) => a.phoneRank - b.phoneRank || (columns[b.index].stats.phoneShare - columns[a.index].stats.phoneShare) || a.index - b.index);
  const phoneSlot = new Map<number, PhoneTarget>();
  phoneCols.forEach((c, i) => phoneSlot.set(c.index, PHONE_TARGETS[i]));

  return columns.map((col) => {
    const c = chosen.get(col.index);
    if (!c) {
      return {
        index: col.index,
        target: 'ignore' as ImportTarget,
        confidence: col.stats.nonEmpty === 0 ? 1 : 0.8,
        reason: col.stats.nonEmpty === 0 ? 'column is empty' : 'not recognised',
        keepAsExtra: keepExtra.get(col.index) ?? false,
      };
    }
    const target: ImportTarget = c.field === 'phone' ? phoneSlot.get(col.index)! : c.field;
    return { index: col.index, target, confidence: Math.round(c.score * 100) / 100, reason: c.reason, keepAsExtra: false };
  });
}

/**
 * Admin changes one column's target. Single-use targets move: the column that had it becomes
 * "don't import". Changing the target marks the mapping as certain.
 */
export function setColumnTarget(mappings: ColumnMapping[], index: number, target: ImportTarget): ColumnMapping[] {
  return mappings.map((m) => {
    if (m.index === index) return { ...m, target, confidence: 1, reason: 'chosen by you', keepAsExtra: target === 'ignore' ? m.keepAsExtra : false };
    if (!MULTI_TARGETS.has(target) && m.target === target) return { ...m, target: 'ignore', confidence: 1, reason: 'replaced by your choice', keepAsExtra: false };
    return m;
  });
}

export function setKeepAsExtra(mappings: ColumnMapping[], index: number, keep: boolean): ColumnMapping[] {
  return mappings.map((m) => (m.index === index ? { ...m, keepAsExtra: keep } : m));
}

export interface MappingWarnings {
  noPhone: boolean;
  noName: boolean;
  /** Columns whose guess is weak. */
  weak: number[];
}

export function mappingWarnings(mappings: ColumnMapping[]): MappingWarnings {
  const targets = new Set(mappings.map((m) => m.target));
  return {
    noPhone: !PHONE_TARGETS.some((t) => targets.has(t)),
    noName: !targets.has('businessName') && !targets.has('contactName') && !targets.has('firstName') && !targets.has('lastName'),
    weak: mappings.filter((m) => m.target !== 'ignore' && m.confidence < WEAK_CONFIDENCE).map((m) => m.index),
  };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type RowStatus = 'ready' | 'invalid' | 'duplicate' | 'existing';

export interface PreparedRow {
  /** Row number as the admin sees it in the spreadsheet (1-based, header counted). */
  rowNumber: number;
  status: RowStatus;
  /** Why the row is not ready. */
  reason: string;
  /** The lead as it will be imported (also filled for invalid rows, for display). */
  lead: NewLead;
  /** Numbers that were present but unusable. */
  rejectedPhones: string[];
  raw: string[];
}

/** Turn the grid into leads with the given mapping. In-file duplicates share a primary phone. */
export function prepareRows(grid: string[][], hasHeader: boolean, columns: SourceColumn[], mappings: ColumnMapping[]): PreparedRow[] {
  const byTarget = (t: ImportTarget) => mappings.filter((m) => m.target === t).map((m) => m.index);
  const one = (t: ImportTarget) => byTarget(t)[0];
  const phoneCols = PHONE_TARGETS.flatMap((t) => byTarget(t));
  const notesCols = byTarget('notes');
  const extraCols = mappings.filter((m) => m.target === 'ignore' && m.keepAsExtra).map((m) => m.index);
  const bizCol = one('businessName');
  const contactCol = one('contactName');
  const firstCol = one('firstName');
  const lastCol = one('lastName');
  const emailCol = one('email');
  const cityCol = one('city');
  const stateCol = one('state');

  const data = hasHeader ? grid.slice(1) : grid;
  const offset = hasHeader ? 2 : 1;
  const seen = new Map<string, number>();
  const cell = (r: string[], i: number | undefined) => (i === undefined ? '' : (r[i] ?? '').trim());

  return data.map((r, i) => {
    const rowNumber = i + offset;
    const phones: string[] = [];
    const rejected: { value: string; reason: 'international' | 'invalid' }[] = [];
    let anyPhoneText = false;
    for (const c of phoneCols) {
      const v = cell(r, c);
      if (!v) continue;
      anyPhoneText = true;
      const s = splitPhoneCell(v);
      for (const p of s.phones) if (!phones.includes(p)) phones.push(p);
      rejected.push(...s.rejected);
    }
    const usedPhones = phones.slice(0, MAX_PHONES);

    let contactName = cell(r, contactCol);
    if (!contactName) contactName = [cell(r, firstCol), cell(r, lastCol)].filter(Boolean).join(' ');
    let businessName = cell(r, bizCol);
    if (!businessName) businessName = contactName;
    if (!contactName) contactName = businessName;

    const noteLines: string[] = [];
    for (const c of notesCols) {
      const v = cell(r, c);
      if (v) noteLines.push(notesCols.length > 1 ? `${columns[c]?.header ?? ''}: ${v}` : v);
    }
    for (const c of extraCols) {
      const v = cell(r, c);
      if (v) noteLines.push(`${columns[c]?.header ?? `Column ${columnLetter(c)}`}: ${v}`);
    }

    const lead: NewLead = {
      businessName,
      contactName,
      phones: usedPhones,
      email: extractEmail(cell(r, emailCol)),
      city: cell(r, cityCol),
      state: normalizeState(cell(r, stateCol)),
      notes: noteLines.join('\n'),
    };

    let status: RowStatus = 'ready';
    let reason = '';
    if (usedPhones.length === 0) {
      status = 'invalid';
      if (!anyPhoneText) reason = 'No phone number';
      else if (rejected.some((x) => x.reason === 'international')) reason = `Not a US number: ${rejected.map((x) => x.value).join(', ')}`;
      else reason = `Not a valid phone number: ${rejected.map((x) => x.value).join(', ')}`;
    } else if (!businessName) {
      status = 'invalid';
      reason = 'No business or contact name';
    } else {
      const earlier = seen.get(usedPhones[0]);
      if (earlier !== undefined) {
        status = 'duplicate';
        reason = `Same phone as row ${earlier}`;
      } else seen.set(usedPhones[0], rowNumber);
    }
    return { rowNumber, status, reason, lead, rejectedPhones: rejected.map((x) => x.value), raw: r };
  });
}

/** Mark ready rows whose primary phone already belongs to a lead in the system. */
export function markExisting(rows: PreparedRow[], existingPrimaryPhones: ReadonlySet<string>): PreparedRow[] {
  return rows.map((r) =>
    r.status === 'ready' && existingPrimaryPhones.has(r.lead.phones[0]) ? { ...r, status: 'existing' as RowStatus, reason: 'Already in the system (same phone)' } : r,
  );
}

export interface RowCounts {
  total: number;
  ready: number;
  invalid: number;
  duplicate: number;
  existing: number;
}

export function countRows(rows: PreparedRow[]): RowCounts {
  const c: RowCounts = { total: rows.length, ready: 0, invalid: 0, duplicate: 0, existing: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  const n = Math.max(1, Math.floor(size));
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Rotate caller ids so round robin continues evenly across import chunks. */
export function rotate<T>(items: T[], by: number): T[] {
  if (items.length === 0) return items;
  const k = ((by % items.length) + items.length) % items.length;
  return [...items.slice(k), ...items.slice(0, k)];
}

/** Rows for the "skipped rows" CSV: the original cells plus a reason column. */
export function skippedRowsTable(rows: PreparedRow[], columns: SourceColumn[]): { fields: string[]; data: string[][] } {
  const fields = ['Row', 'Reason', ...columns.map((c) => c.header)];
  const data = rows
    .filter((r) => r.status !== 'ready')
    .map((r) => [String(r.rowNumber), r.reason, ...columns.map((c) => r.raw[c.index] ?? '')]);
  return { fields, data };
}

// ---------------------------------------------------------------------------
// One-shot analysis
// ---------------------------------------------------------------------------

export interface SheetAnalysis {
  grid: string[][];
  hasHeader: boolean;
  columns: SourceColumn[];
  mappings: ColumnMapping[];
}

/** Parse + detect header + columns + guesses. `hasHeader` can be forced (the admin's toggle). */
export function analyzeSheet(text: string, opts: { hasHeader?: boolean; delimiter?: string } = {}): SheetAnalysis {
  const grid = parseSheetText(text, { delimiter: opts.delimiter });
  return analyzeGrid(grid, opts.hasHeader);
}

export function analyzeGrid(grid: string[][], hasHeaderOverride?: boolean): SheetAnalysis {
  const hasHeader = hasHeaderOverride ?? detectHeader(grid);
  const columns = buildColumns(grid, hasHeader);
  return { grid, hasHeader, columns, mappings: guessMappings(columns) };
}
