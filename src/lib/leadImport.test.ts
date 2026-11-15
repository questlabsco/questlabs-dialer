import { describe, expect, it } from 'vitest';
import {
  analyzeSheet,
  checkUsPhone,
  chunk,
  countRows,
  detectHeader,
  guessMappings,
  buildColumns,
  isUnsupportedSpreadsheet,
  listNameFromFileName,
  mappingWarnings,
  markExisting,
  normalizeState,
  parseSheetText,
  prepareRows,
  rotate,
  setColumnTarget,
  skippedRowsTable,
  splitPhoneCell,
  WEAK_CONFIDENCE,
  type ColumnMapping,
  type ImportTarget,
  type SheetAnalysis,
} from './leadImport';
import { DemoApi } from '../api/demoApi';

function targetOf(a: SheetAnalysis, header: string): ImportTarget {
  const col = a.columns.find((c) => c.header === header);
  if (!col) throw new Error(`no column ${header}`);
  return a.mappings[col.index].target;
}

function mappingOf(a: SheetAnalysis, header: string): ColumnMapping {
  const col = a.columns.find((c) => c.header === header)!;
  return a.mappings[col.index];
}

function rowsOf(a: SheetAnalysis) {
  return prepareRows(a.grid, a.hasHeader, a.columns, a.mappings);
}

const APOLLO = [
  'First Name,Last Name,Title,Company,Company Name for Emails,Email,Email Status,Seniority,Departments,Contact Owner,First Phone,Work Direct Phone,Home Phone,Mobile Phone,Corporate Phone,Other Phone,Stage,Lists,Last Contacted,Account Owner,# Employees,Industry,Keywords,Person Linkedin Url,Website,Company Linkedin Url,City,State,Country,Company Address,Company City,Company State,Company Country,Company Phone,Apollo Contact Id',
  'Maria,Lopez,Owner,Lopez Plumbing LLC,Lopez Plumbing,maria@lopezplumbing.com,Verified,Owner,,rep@questlabs.example,,,,(214) 555-0101,+1 972-555-0199,,Cold,,,rep@questlabs.example,12,Construction,plumbing,http://linkedin.com/in/x,lopezplumbing.com,,Dallas,Texas,United States,1 Main St,Dallas,Texas,United States,+1 972-555-0199,abc123',
  'James,Nguyen,CEO,Nguyen Roofing,Nguyen Roofing,james@nguyenroofing.com,Verified,C suite,,rep@questlabs.example,,,,,+1 817-555-0142,,Cold,,,rep@questlabs.example,30,Construction,roofing,,nguyenroofing.com,,Fort Worth,Texas,United States,2 Elm St,Fort Worth,Texas,United States,+1 817-555-0142,def456',
  'Ann,Smith,Owner,Smith Dental PLLC,Smith Dental,ann@smithdental.com,Unavailable,Owner,,rep@questlabs.example,,(469) 555-0177,,(469) 555-0178,,,Cold,,,rep@questlabs.example,8,Health,dental,,smithdental.com,,Plano,TX,United States,3 Oak St,Plano,TX,United States,,ghi789',
].join('\n');

describe('parseSheetText', () => {
  it('handles a BOM, CRLF, blank lines and ragged rows', () => {
    const text = '\uFEFFName,Phone,City\r\n\r\nJoe,2145550111\r\nAnn,2145550112,Dallas,extra\r\n,,\r\nBob\r\n';
    const grid = parseSheetText(text);
    expect(grid[0]).toEqual(['Name', 'Phone', 'City', '']);
    expect(grid).toHaveLength(4);
    expect(grid.every((r) => r.length === 4)).toBe(true);
    expect(grid[3]).toEqual(['Bob', '', '', '']);
  });

  it('splits pasted Excel / Google Sheets cells on tabs', () => {
    const pasted = 'Business\tOwner\tCell\nAce Auto Repair\tTom Hill\t214.555.0131\nBright Cleaning Co\tSue Park\t(972) 555 0132\n';
    const a = analyzeSheet(pasted);
    expect(a.hasHeader).toBe(true);
    expect(a.columns.map((c) => c.header)).toEqual(['Business', 'Owner', 'Cell']);
    expect(targetOf(a, 'Business')).toBe('businessName');
    expect(targetOf(a, 'Owner')).toBe('contactName');
    expect(targetOf(a, 'Cell')).toBe('phone1');
    const rows = rowsOf(a);
    expect(rows.map((r) => r.lead.phones[0])).toEqual(['+12145550131', '+19725550132']);
  });

  it('auto-detects semicolon delimiters and quoted commas', () => {
    const grid = parseSheetText('Company;Phone\n"Smith, Jones & Co";214-555-0150\n');
    expect(grid[1]).toEqual(['Smith, Jones & Co', '214-555-0150']);
  });

  it('recognises Excel files we cannot read', () => {
    expect(isUnsupportedSpreadsheet('leads.xlsx')).toBe(true);
    expect(isUnsupportedSpreadsheet('leads.XLS')).toBe(true);
    expect(isUnsupportedSpreadsheet('leads.csv')).toBe(false);
    expect(listNameFromFileName('C:\\x\\Dallas plumbers (2).csv')).toBe('Dallas plumbers (2)');
  });
});

describe('Apollo-style export', () => {
  const a = analyzeSheet(APOLLO);

  it('maps the useful columns and ignores the rest', () => {
    expect(a.hasHeader).toBe(true);
    expect(targetOf(a, 'First Name')).toBe('firstName');
    expect(targetOf(a, 'Last Name')).toBe('lastName');
    expect(targetOf(a, 'Company')).toBe('businessName');
    expect(targetOf(a, 'Company Name for Emails')).toBe('ignore');
    expect(targetOf(a, 'Email')).toBe('email');
    expect(targetOf(a, 'Email Status')).toBe('ignore');
    expect(targetOf(a, 'Contact Owner')).toBe('ignore');
    expect(targetOf(a, 'Account Owner')).toBe('ignore');
    expect(targetOf(a, 'City')).toBe('city');
    expect(targetOf(a, 'State')).toBe('state');
    expect(targetOf(a, 'Apollo Contact Id')).toBe('ignore');
    expect(targetOf(a, 'Industry')).toBe('ignore');
    expect(mappingOf(a, 'Title').keepAsExtra).toBe(true);
  });

  it('orders phone columns mobile / direct first, company / corporate last', () => {
    const phoneHeaders = (['phone1', 'phone2', 'phone3', 'phone4', 'phone5'] as const)
      .map((t) => a.columns[a.mappings.findIndex((m) => m.target === t)]?.header)
      .filter(Boolean);
    expect(phoneHeaders[0]).toBe('Mobile Phone');
    expect(phoneHeaders[1]).toBe('Work Direct Phone');
    // Corporate / company numbers come after the personal ones.
    const corp = phoneHeaders.indexOf('Corporate Phone');
    const home = phoneHeaders.indexOf('Home Phone');
    if (corp >= 0 && home >= 0) expect(corp).toBeGreaterThan(home);
  });

  it('builds leads with combined names, mobile first, normalised state', () => {
    const rows = rowsOf(a);
    expect(countRows(rows)).toMatchObject({ ready: 3, invalid: 0, duplicate: 0 });
    const [maria, james, ann] = rows.map((r) => r.lead);
    expect(maria.businessName).toBe('Lopez Plumbing LLC');
    expect(maria.contactName).toBe('Maria Lopez');
    expect(maria.phones).toEqual(['+12145550101', '+19725550199']);
    expect(maria.state).toBe('TX');
    expect(maria.city).toBe('Dallas');
    expect(maria.email).toBe('maria@lopezplumbing.com');
    expect(maria.notes).toContain('Title: Owner');
    // Only a corporate phone: still importable.
    expect(james.phones).toEqual(['+18175550142']);
    // Mobile before work direct.
    expect(ann.phones).toEqual(['+14695550178', '+14695550177']);
  });
});

describe('minimal and odd files', () => {
  it('handles a minimal "Name, Phone" file (name doubles as business name)', () => {
    const a = analyzeSheet('Name,Phone\nJoe Carter,214-555-0160\nLinda Ray,214 555 0161\n');
    expect(targetOf(a, 'Phone')).toBe('phone1');
    expect(['contactName', 'businessName']).toContain(targetOf(a, 'Name'));
    const rows = rowsOf(a);
    expect(rows.every((r) => r.status === 'ready')).toBe(true);
    expect(rows[0].lead.businessName).toBe('Joe Carter');
    expect(rows[0].lead.contactName).toBe('Joe Carter');
    expect(mappingWarnings(a.mappings)).toMatchObject({ noPhone: false, noName: false });
  });

  it('detects a header-less file and maps it by content', () => {
    const text = [
      'Acme Plumbing LLC,John Doe,(214) 555-0170,john@acme.com,Dallas,TX',
      'Best Roofing Inc,Jane Roe,(817) 555-0171,jane@best.com,Fort Worth,TX',
      'City HVAC Services,Sam Poe,(972) 555-0172,sam@cityhvac.com,Plano,TX',
    ].join('\n');
    const a = analyzeSheet(text);
    expect(a.hasHeader).toBe(false);
    expect(a.columns.map((c) => c.header)).toEqual(['Column A', 'Column B', 'Column C', 'Column D', 'Column E', 'Column F']);
    expect(a.mappings.map((m) => m.target)).toEqual(['businessName', 'contactName', 'phone1', 'email', 'city', 'state']);
    const rows = rowsOf(a);
    expect(rows).toHaveLength(3);
    expect(rows[0].rowNumber).toBe(1);
    expect(rows[0].lead).toMatchObject({ businessName: 'Acme Plumbing LLC', contactName: 'John Doe', phones: ['+12145550170'] });
  });

  it('resolves unhelpful headers from the cell contents', () => {
    const text = [
      'Field1,Field2,Field3,Info,Data',
      'Garcia Landscaping,972-555-0180,Mesquite,Texas,garcia@landscape.com',
      'Pro Auto Repair,972-555-0181,Garland,Texas,info@proauto.com',
      'Clean Co,972-555-0182,Irving,Oklahoma,hello@cleanco.com',
      'Lone Star Pest Control,972-555-0183,Frisco,Texas,ls@pest.com',
    ].join('\n');
    const a = analyzeSheet(text);
    expect(a.hasHeader).toBe(true);
    expect(targetOf(a, 'Field1')).toBe('businessName');
    expect(targetOf(a, 'Field2')).toBe('phone1');
    expect(targetOf(a, 'Field3')).toBe('city');
    expect(targetOf(a, 'Info')).toBe('state');
    expect(targetOf(a, 'Data')).toBe('email');
    expect(rowsOf(a)[0].lead.state).toBe('TX');
  });

  it('downgrades a header whose values contradict it', () => {
    const text = 'Company,Phone,Number\nAcme LLC,Yes,214-555-0190\nBeta Inc,No,214-555-0191\nGamma Co,Yes,214-555-0192\n';
    const a = analyzeSheet(text);
    expect(targetOf(a, 'Number')).toBe('phone1');
    expect(targetOf(a, 'Phone')).not.toBe('phone1');
  });

  it('flags weak guesses and warns when no phone is mapped', () => {
    const a = analyzeSheet('Name,Thing\nJoe,abc\nAnn,def\n');
    const w = mappingWarnings(a.mappings);
    expect(w.noPhone).toBe(true);
    expect(w.weak.length).toBeGreaterThan(0);
    expect(a.mappings[w.weak[0]].confidence).toBeLessThan(WEAK_CONFIDENCE);
  });
});

describe('phones', () => {
  it('splits several numbers in one cell', () => {
    expect(splitPhoneCell('214-555-0101 / 972-555-0102').phones).toEqual(['+12145550101', '+19725550102']);
    expect(splitPhoneCell('214-555-0101; 972-555-0102, 817-555-0103').phones).toEqual(['+12145550101', '+19725550102', '+18175550103']);
    expect(splitPhoneCell('214-555-0101\n972-555-0102').phones).toEqual(['+12145550101', '+19725550102']);
    expect(splitPhoneCell('214/555-0101').phones).toEqual(['+12145550101']);
  });

  it('strips extensions', () => {
    expect(splitPhoneCell('(214) 555-0101 x123').phones).toEqual(['+12145550101']);
    expect(splitPhoneCell('214.555.0101 ext. 4').phones).toEqual(['+12145550101']);
    expect(splitPhoneCell('214-555-0101 ext 4 / 972-555-0102 x9').phones).toEqual(['+12145550101', '+19725550102']);
    expect(checkUsPhone('2145550101.0')).toEqual({ ok: true, e164: '+12145550101' });
  });

  it('rejects invalid and international numbers', () => {
    expect(checkUsPhone('+44 20 7946 0958')).toEqual({ ok: false, reason: 'international' });
    expect(checkUsPhone('555-0101')).toEqual({ ok: false, reason: 'invalid' });
    expect(checkUsPhone('(123) 555-0101')).toEqual({ ok: false, reason: 'invalid' });
    expect(checkUsPhone('+1 214 555 0101')).toEqual({ ok: true, e164: '+12145550101' });
  });

  it('spreads numbers over phones 1–3 and explains invalid rows', () => {
    const text = [
      'Business,Phones,Other',
      'A LLC,214-555-0101 / 972-555-0102,817-555-0103 / 469-555-0104',
      'B LLC,+44 20 7946 0958,',
      'C LLC,call me,',
      'D LLC,,',
    ].join('\n');
    const a = analyzeSheet(text);
    const rows = rowsOf(a);
    expect(rows[0].lead.phones).toEqual(['+12145550101', '+19725550102', '+18175550103']);
    expect(rows[1]).toMatchObject({ status: 'invalid' });
    expect(rows[1].reason).toMatch(/Not a US number/);
    expect(rows[2].reason).toMatch(/Not a valid phone number/);
    expect(rows[3].reason).toBe('No phone number');
    expect(countRows(rows)).toMatchObject({ ready: 1, invalid: 3 });
  });
});

describe('states, duplicates, mapping edits', () => {
  it('normalises full state names', () => {
    expect(normalizeState('Texas')).toBe('TX');
    expect(normalizeState('new york')).toBe('NY');
    expect(normalizeState('tx')).toBe('TX');
    expect(normalizeState('Tex.')).toBe('TX');
    expect(normalizeState('District of Columbia')).toBe('DC');
    expect(normalizeState('Narnia')).toBe('');
  });

  it('marks in-file duplicates by primary phone and existing leads', () => {
    const text = 'Company,Phone\nA LLC,214-555-0101\nB LLC,(214) 555-0101\nC LLC,214-555-0102\nD LLC,214-555-0103\n';
    const a = analyzeSheet(text);
    let rows = rowsOf(a);
    expect(rows[1]).toMatchObject({ status: 'duplicate', reason: 'Same phone as row 2' });
    rows = markExisting(rows, new Set(['+12145550103']));
    expect(countRows(rows)).toMatchObject({ ready: 2, duplicate: 1, existing: 1 });
    const skipped = skippedRowsTable(rows, a.columns);
    expect(skipped.fields).toEqual(['Row', 'Reason', 'Company', 'Phone']);
    expect(skipped.data.map((r) => r[0])).toEqual(['3', '5']);
  });

  it('keeps single-use targets unique when the admin changes one', () => {
    const a = analyzeSheet('Company,Owner,Phone,Alt\nA LLC,Joe Hill,214-555-0101,972-555-0102\n');
    expect(targetOf(a, 'Alt')).toBe('phone2');
    const m = setColumnTarget(a.mappings, 3, 'phone1');
    expect(m[3].target).toBe('phone1');
    expect(m[2].target).toBe('ignore');
    const m2 = setColumnTarget(m, 2, 'notes');
    const m3 = setColumnTarget(m2, 1, 'notes');
    expect(m3.filter((x) => x.target === 'notes')).toHaveLength(2);
  });

  it('appends "keep as extra" columns to notes', () => {
    const a = analyzeSheet('Company,Phone,Zip,Notes\nA LLC,214-555-0101,75201,Prefers mornings\n');
    const zip = a.columns.findIndex((c) => c.header === 'Zip');
    const m = a.mappings.map((x) => (x.index === zip ? { ...x, keepAsExtra: true } : x));
    const rows = prepareRows(a.grid, a.hasHeader, a.columns, m);
    expect(rows[0].lead.notes).toBe('Prefers mornings\nZip: 75201');
  });

  it('detectHeader works from content', () => {
    expect(detectHeader([['Joe', '2145550101'], ['Ann', '2145550102']])).toBe(false);
    expect(detectHeader([['who', 'how to reach'], ['Joe', '2145550101']])).toBe(true);
    const cols = buildColumns([['a', 'b']], false);
    expect(guessMappings(cols)).toHaveLength(2);
  });

  it('chunks and rotates', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(rotate(['a', 'b', 'c'], 4)).toEqual(['b', 'c', 'a']);
  });
});

describe('whole pipeline into the demo api', () => {
  it('parses, maps and imports leads that then exist', async () => {
    const api = new DemoApi({ storage: null, now: () => new Date(2026, 10, 11, 14, 0, 0).getTime(), simulatePresence: false, empty: true });
    await api.signInDemo('admin');
    const callers = (await api.listUsers()).filter((u) => u.role === 'caller' && u.active);
    const csv = [
      'Business Name,Owner,Cell Phone,Office Phone,E-mail,Town,Region,Comments',
      'Lopez Plumbing LLC,Maria Lopez,(214) 555-0101,972-555-0199,maria@lp.com,Dallas,Texas,Wants a quote',
      'Nguyen Roofing,James Nguyen,,817-555-0142,james@nr.com,Fort Worth,TX,',
      'Bad Row LLC,Nobody,+44 20 7946 0958,,,,,',
      'Lopez Again,Maria,214.555.0101,,,,,',
    ].join('\n');
    const a = analyzeSheet(csv);
    const rows = rowsOf(a);
    const counts = countRows(rows);
    expect(counts).toMatchObject({ ready: 2, invalid: 1, duplicate: 1 });
    const ready = rows.filter((r) => r.status === 'ready').map((r) => r.lead);
    const res = await api.importLeads({ newListName: 'Test import', rows: ready, assign: { mode: 'round_robin', callerIds: callers.slice(0, 2).map((c) => c.id) } });
    expect(res).toMatchObject({ imported: 2, duplicates: 0, invalid: 0 });
    const found = await api.queryLeads({ listId: res.listId, page: 1, pageSize: 10, sort: { field: 'businessName', dir: 'asc' } });
    expect(found.total).toBe(2);
    const lopez = found.rows[0];
    expect(lopez).toMatchObject({
      businessName: 'Lopez Plumbing LLC',
      contactName: 'Maria Lopez',
      phones: ['+12145550101', '+19725550199'],
      email: 'maria@lp.com',
      city: 'Dallas',
      state: 'TX',
      notes: 'Wants a quote',
      status: 'new',
    });
    expect(new Set(found.rows.map((l) => l.assignedTo)).size).toBe(2);

    // Re-importing the same sheet: everything is already in the system.
    const existing = new Set((await api.exportLeads({})).map((l) => l.phones[0]));
    const again = markExisting(rowsOf(a), existing);
    expect(countRows(again).existing).toBe(2);
    const res2 = await api.importLeads({ listId: res.listId, rows: ready, assign: { mode: 'pool' } });
    expect(res2).toMatchObject({ imported: 0, duplicates: 2 });
  });
});

describe('map-scraper exports', () => {
  it('reads "title" as the business name and never uses the category as a name', () => {
    const a = analyzeSheet(
      [
        'title,categoryName,address,city,state,phone,website,totalScore,reviewsCount',
        '"Ace Plumbing & Drain",Plumber,"4410 Maple Ave, Dallas, TX 75219",Dallas,Texas,(214) 555-0143,https://ace.example,4.8,212',
        '"Lone Star Roofing",Roofing contractor,"900 Main St, Fort Worth, TX 76102",Fort Worth,Texas,+1 817-555-0190,,4.5,88',
      ].join('\n'),
    );
    const rows = prepareRows(a.grid, a.hasHeader, a.columns, a.mappings);
    expect(rows.map((r) => r.lead.businessName)).toEqual(['Ace Plumbing & Drain', 'Lone Star Roofing']);
    expect(rows.map((r) => r.lead.phones[0])).toEqual(['+12145550143', '+18175550190']);
    expect(rows[0]!.lead.notes).toContain('Plumber');
  });

  it('keeps "Title" as a job title in contact exports', () => {
    const a = analyzeSheet(
      ['First Name,Last Name,Title,Company,Mobile Phone', 'Dana,Cole,Owner,Cole Landscaping,+1 214-555-0188', 'Raj,Patel,Founder,Patel Auto Glass,(817) 555-0123'].join('\n'),
    );
    const rows = prepareRows(a.grid, a.hasHeader, a.columns, a.mappings);
    expect(rows.map((r) => r.lead.businessName)).toEqual(['Cole Landscaping', 'Patel Auto Glass']);
    expect(rows.map((r) => r.lead.contactName)).toEqual(['Dana Cole', 'Raj Patel']);
  });
});
