import { useMemo, useRef, useState, type DragEvent } from 'react';
import { api, errorMessage } from '../../../api';
import type { AssignTarget, ImportResult } from '../../../api/Api';
import { Badge, Button, Checkbox, IconAlert, IconCheck, IconDownload, IconUpload, Input, Modal, Select, StatTile, Textarea } from '../../../components/ui';
import { formatDate, formatPhone } from '../../../lib/format';
import {
  IMPORT_TARGETS,
  LEAD_TEMPLATE,
  UNSUPPORTED_SPREADSHEET_MESSAGE,
  WEAK_CONFIDENCE,
  analyzeGrid,
  chunk,
  countRows,
  isUnsupportedSpreadsheet,
  listNameFromFileName,
  mappingWarnings,
  markExisting,
  parseSheetText,
  prepareRows,
  rotate,
  setColumnTarget,
  setKeepAsExtra,
  skippedRowsTable,
  type ImportTarget,
  type PreparedRow,
  type SheetAnalysis,
} from '../../../lib/leadImport';
import type { LeadList, Profile } from '../../../types';
import { downloadCsv, plural, safeFileName } from './leadUi';

interface Props {
  open: boolean;
  lists: LeadList[];
  users: Profile[];
  /** Called when the wizard closes; `listId` is set when something was imported. */
  onClose: (listId: string | null) => void;
}

type Step = 'source' | 'columns' | 'preview' | 'destination' | 'importing' | 'done';
const STEPS: { id: Step; label: string }[] = [
  { id: 'source', label: 'Choose file' },
  { id: 'columns', label: 'Match columns' },
  { id: 'preview', label: 'Check leads' },
  { id: 'destination', label: 'Where they go' },
  { id: 'done', label: 'Import' },
];

const CHUNK_SIZE = 500;
const PREVIEW_ROWS = 20;

interface Summary {
  imported: number;
  existing: number;
  invalid: number;
  inFileDuplicates: number;
  /** Duplicates the server found that we could not point to a specific row for. */
  serverOnlyDuplicates: number;
  listId: string | null;
  error: string;
  /** Existing leads could not be looked up before importing. */
  precheckFailed?: boolean;
}

const STATUS_BADGE: Record<PreparedRow['status'], { tone: 'good' | 'critical' | 'warning' | 'neutral'; label: string }> = {
  ready: { tone: 'good', label: 'Ready' },
  invalid: { tone: 'critical', label: 'Can’t import' },
  duplicate: { tone: 'warning', label: 'Duplicate in file' },
  existing: { tone: 'neutral', label: 'Already in system' },
};

export function ImportWizard({ open, lists, users, onClose }: Props) {
  const [step, setStep] = useState<Step>('source');
  const [sourceName, setSourceName] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [pasted, setPasted] = useState('');
  const [dragging, setDragging] = useState(false);
  const [analysis, setAnalysis] = useState<SheetAnalysis | null>(null);
  const [destMode, setDestMode] = useState<'new' | 'existing'>('new');
  const [newListName, setNewListName] = useState('');
  const [existingListId, setExistingListId] = useState('');
  const [assignMode, setAssignMode] = useState<'pool' | 'caller' | 'round_robin'>('pool');
  const [callerId, setCallerId] = useState('');
  const [rrCallers, setRrCallers] = useState<string[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [finalRows, setFinalRows] = useState<PreparedRow[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const callers = useMemo(() => users.filter((u) => u.role === 'caller' && u.active), [users]);

  const rows = useMemo(() => (analysis ? prepareRows(analysis.grid, analysis.hasHeader, analysis.columns, analysis.mappings) : []), [analysis]);
  const counts = useMemo(() => countRows(rows), [rows]);
  const warnings = useMemo(() => (analysis ? mappingWarnings(analysis.mappings) : null), [analysis]);

  const reset = () => {
    setStep('source');
    setSourceName('');
    setSourceError('');
    setPasted('');
    setAnalysis(null);
    setDestMode('new');
    setNewListName('');
    setExistingListId('');
    setAssignMode('pool');
    setCallerId('');
    setRrCallers([]);
    setProgress({ done: 0, total: 0 });
    setSummary(null);
    setFinalRows([]);
  };

  const close = () => {
    const listId = summary?.listId ?? null;
    reset();
    onClose(listId);
  };

  const loadText = (text: string, name: string, listName: string) => {
    const grid = parseSheetText(text);
    if (grid.length === 0) {
      setSourceError('That file looks empty. Check that it has rows of leads in it.');
      return;
    }
    const a = analyzeGrid(grid);
    if (a.columns.length < 1 || (a.hasHeader && grid.length < 2)) {
      setSourceError('We found column names but no leads under them.');
      return;
    }
    setSourceError('');
    setSourceName(name);
    setAnalysis(a);
    setNewListName(listName);
    setStep('columns');
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (isUnsupportedSpreadsheet(file.name)) {
      setSourceError(UNSUPPORTED_SPREADSHEET_MESSAGE);
      return;
    }
    try {
      const text = await file.text();
      if (/\u0000/.test(text.slice(0, 2000))) {
        setSourceError(`"${file.name}" doesn't look like a text file. ${UNSUPPORTED_SPREADSHEET_MESSAGE}`);
        return;
      }
      loadText(text, file.name, listNameFromFileName(file.name));
    } catch (e) {
      setSourceError(`Couldn't read the file: ${errorMessage(e)}`);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void onFile(e.dataTransfer.files?.[0]);
  };

  const toggleHeader = (hasHeader: boolean) => {
    if (!analysis) return;
    setAnalysis(analyzeGrid(analysis.grid, hasHeader));
  };

  const changeTarget = (index: number, target: ImportTarget) => {
    if (!analysis) return;
    setAnalysis({ ...analysis, mappings: setColumnTarget(analysis.mappings, index, target) });
  };

  const changeExtra = (index: number, keep: boolean) => {
    if (!analysis) return;
    setAnalysis({ ...analysis, mappings: setKeepAsExtra(analysis.mappings, index, keep) });
  };

  const destinationError = (() => {
    if (destMode === 'new' && !newListName.trim()) return 'Give the new list a name.';
    if (destMode === 'existing' && !existingListId) return 'Choose a list.';
    if (assignMode === 'caller' && !callerId) return 'Choose a caller.';
    if (assignMode === 'round_robin' && rrCallers.length === 0) return 'Tick at least one caller.';
    return '';
  })();

  const runImport = async () => {
    if (!analysis) return;
    setStep('importing');
    // Find rows whose phone is already in the system, so the skipped-rows file can say which.
    let prepared = rows;
    let precheck = true;
    try {
      const existing = await api.exportLeads({});
      prepared = markExisting(rows, new Set(existing.flatMap((l) => l.phones).filter(Boolean)));
    } catch {
      precheck = false;
    }
    const ready = prepared.filter((r) => r.status === 'ready');
    const c = countRows(prepared);
    const result: Summary = { imported: 0, existing: c.existing, invalid: c.invalid, inFileDuplicates: c.duplicate, serverOnlyDuplicates: 0, listId: null, error: '' };
    setFinalRows(prepared);
    setProgress({ done: 0, total: ready.length });

    let listId: string | null = destMode === 'existing' ? existingListId : null;
    const batches = chunk(ready, CHUNK_SIZE);
    try {
      for (const batch of batches) {
        let assign: AssignTarget = { mode: 'pool' };
        if (assignMode === 'caller') assign = { mode: 'caller', callerId };
        if (assignMode === 'round_robin') assign = { mode: 'round_robin', callerIds: rotate(rrCallers, result.imported) };
        const leads = batch.map((r) => r.lead);
        const res: ImportResult = listId
          ? await api.importLeads({ listId, rows: leads, assign })
          : await api.importLeads({ newListName: newListName.trim(), rows: leads, assign });
        listId = res.listId;
        result.listId = listId;
        result.imported += res.imported;
        result.serverOnlyDuplicates += res.duplicates;
        result.invalid += res.invalid;
        setProgress((p) => ({ ...p, done: p.done + batch.length }));
      }
    } catch (e) {
      result.error = errorMessage(e);
    }
    result.listId = listId;
    result.precheckFailed = !precheck;
    // Server duplicates count as "already in the system".
    result.existing += result.serverOnlyDuplicates;
    setSummary(result);
    setStep('done');
  };

  const downloadSkipped = () => {
    if (!analysis) return;
    const t = skippedRowsTable(finalRows, analysis.columns);
    downloadCsv(`${safeFileName(listNameFromFileName(sourceName || 'import'))} - skipped rows.csv`, t.fields, t.data);
  };

  const stepIndex = STEPS.findIndex((s) => s.id === (step === 'importing' ? 'done' : step));
  const busy = step === 'importing';

  const footer = (() => {
    switch (step) {
      case 'source':
        return (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" disabled={!pasted.trim()} onClick={() => loadText(pasted, 'Pasted cells', `Pasted leads ${formatDate(new Date())}`)}>
              Use pasted cells
            </Button>
          </>
        );
      case 'columns':
        return (
          <>
            <Button onClick={() => setStep('source')}>Back</Button>
            <Button variant="primary" disabled={!!warnings?.noPhone} onClick={() => setStep('preview')}>
              Next: check leads
            </Button>
          </>
        );
      case 'preview':
        return (
          <>
            <Button onClick={() => setStep('columns')}>Back</Button>
            <Button variant="primary" disabled={counts.ready === 0} onClick={() => setStep('destination')}>
              Next: where they go
            </Button>
          </>
        );
      case 'destination':
        return (
          <>
            <Button onClick={() => setStep('preview')}>Back</Button>
            <Button variant="primary" disabled={!!destinationError} onClick={() => void runImport()} title={destinationError || undefined}>
              Import {plural(counts.ready, 'lead')}
            </Button>
          </>
        );
      case 'importing':
        return null;
      case 'done':
        return (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        );
    }
  })();

  return (
    <Modal open={open} onClose={close} title="Import leads" size="lg" dismissible={!busy} footer={footer}>
      <div className="import-wizard">
        <ol className="import-steps" aria-label="Import steps">
          {STEPS.map((s, i) => (
            <li key={s.id} className={i < stepIndex ? 'done' : i === stepIndex ? 'current' : ''} aria-current={i === stepIndex ? 'step' : undefined}>
              <span className="step-num">{i < stepIndex ? <IconCheck size={12} /> : i + 1}</span>
              <span className="step-label">{s.label}</span>
            </li>
          ))}
        </ol>

        {step === 'source' && (
          <div className="stack">
            <div
              className={`dropzone ${dragging ? 'dragging' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <IconUpload size={18} />
              <div>
                <strong>Drop a CSV, TSV or TXT file</strong>
                <div className="muted adm-small">Columns are matched automatically; you can change them in the next step.</div>
              </div>
              <Button icon={<IconUpload />} onClick={() => fileInput.current?.click()}>
                Choose file
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.tsv,.txt,.tab,.xlsx,.xls,text/csv,text/plain,text/tab-separated-values"
                hidden
                onChange={(e) => {
                  void onFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
            {sourceError && (
              <div className="form-error" role="alert">
                {sourceError}
              </div>
            )}
            <div className="import-template">
              <div>
                <strong>Not sure how to lay out your list?</strong>
                <div className="muted adm-small">
                  Use the template: one row per person, a phone number on every row, and the company or contact name. Keep
                  links (LinkedIn, job posts) out of the phone columns. Delete the two example rows before importing.
                </div>
              </div>
              <Button
                size="sm"
                icon={<IconDownload />}
                onClick={() => downloadCsv(LEAD_TEMPLATE.fileName, LEAD_TEMPLATE.fields, LEAD_TEMPLATE.rows)}
              >
                Download template
              </Button>
            </div>
            <Textarea
              label="Or paste cells from Excel or Google Sheets"
              hint="Include the header row if there is one"
              rows={6}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              className="mono paste-box"
              placeholder={'Company\tOwner\tPhone\nAce Plumbing\tJoe Smith\t(214) 555-0123'}
            />
          </div>
        )}

        {step === 'columns' && analysis && warnings && (
          <div className="stack">
            <div className="row adm-wrap">
              <span className="muted">
                {sourceName} · {plural(rows.length, 'row')} · {plural(analysis.columns.length, 'column')}
              </span>
              <span className="spacer" />
              <Checkbox label="First row has column names" checked={analysis.hasHeader} onChange={toggleHeader} />
            </div>
            {warnings.noPhone && (
              <div className="adm-callout adm-callout-critical">
                <IconAlert /> No phone column set. Every lead needs a phone; pick the phone column below.
              </div>
            )}
            {warnings.noName && (
              <div className="adm-callout adm-callout-warning">
                <IconAlert /> No business or contact name column set.
              </div>
            )}
            {warnings.weak.length > 0 && (
              <div className="adm-callout adm-callout-warning">
                <IconAlert /> {plural(warnings.weak.length, 'column')} marked "Check this". Confirm or change them.
              </div>
            )}
            <div className="table-wrap mapping-table-wrap">
              <table className="table dense mapping-table">
                <thead>
                  <tr>
                    <th scope="col">File column</th>
                    <th scope="col">Sample values</th>
                    <th scope="col">Import as</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.columns.map((col) => {
                    const m = analysis.mappings[col.index];
                    const weak = m.target !== 'ignore' && m.confidence < WEAK_CONFIDENCE;
                    return (
                      <tr key={col.index} className={m.target === 'ignore' ? 'is-ignored' : undefined}>
                        <td className="map-col">
                          <div className="map-header" title={col.header}>
                            {col.header}
                          </div>
                          <div className="muted adm-small">Column {col.letter}</div>
                        </td>
                        <td className="map-samples">
                          {col.samples.length === 0 ? (
                            <span className="muted">(empty)</span>
                          ) : (
                            col.samples.map((s, i) => (
                              <div key={i} className="sample" title={s}>
                                {s}
                              </div>
                            ))
                          )}
                        </td>
                        <td className="map-target">
                          <Select
                            aria-label={`Import ${col.header} as`}
                            value={m.target}
                            onChange={(e) => changeTarget(col.index, e.target.value as ImportTarget)}
                            options={IMPORT_TARGETS.map((t) => ({ value: t.value, label: t.label }))}
                          />
                          {weak && (
                            <div className="map-flag" title={m.reason}>
                              <Badge tone="warning">Check this</Badge> <span className="muted adm-small">{m.reason}</span>
                            </div>
                          )}
                          {m.target === 'ignore' && col.samples.length > 0 && (
                            <Checkbox label="Keep as extra details in notes" checked={m.keepAsExtra} onChange={(v) => changeExtra(col.index, v)} className="adm-small" />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {step === 'preview' && analysis && (
          <div className="stack">
            <div className="stat-grid">
              <StatTile label="Ready to import" value={counts.ready.toLocaleString('en-US')} />
              <StatTile label="Can't import" value={counts.invalid.toLocaleString('en-US')} sub="no usable phone or name" />
              <StatTile label="Duplicates in file" value={counts.duplicate.toLocaleString('en-US')} sub="same phone as an earlier row" />
            </div>
            <p className="muted adm-small">
              First {Math.min(PREVIEW_ROWS, rows.length)} rows as they will be saved. Phone numbers already in the system are skipped on import.
            </p>
            <div className="table-wrap preview-table-wrap">
              <table className="table dense preview-table">
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Status</th>
                    <th scope="col">Business</th>
                    <th scope="col">Contact</th>
                    <th scope="col">Phones</th>
                    <th scope="col">Email</th>
                    <th scope="col">City, state</th>
                    <th scope="col">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, PREVIEW_ROWS).map((r) => (
                    <tr key={r.rowNumber}>
                      <td className="num muted">{r.rowNumber}</td>
                      <td>
                        <Badge tone={STATUS_BADGE[r.status].tone}>{STATUS_BADGE[r.status].label}</Badge>
                        {r.reason && <div className="muted adm-small adm-cellwrap">{r.reason}</div>}
                      </td>
                      <td className="adm-clip">{r.lead.businessName || <span className="muted">-</span>}</td>
                      <td className="adm-clip">{r.lead.contactName || <span className="muted">-</span>}</td>
                      <td>
                        {r.lead.phones.length === 0 ? (
                          <span className="muted">-</span>
                        ) : (
                          r.lead.phones.map((p) => (
                            <div key={p} className="num">
                              {formatPhone(p)}
                            </div>
                          ))
                        )}
                      </td>
                      <td className="adm-clip">{r.lead.email}</td>
                      <td>{[r.lead.city, r.lead.state].filter(Boolean).join(', ')}</td>
                      <td className="adm-clip notes-cell" title={r.lead.notes}>
                        {r.lead.notes}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {counts.invalid + counts.duplicate > 0 && (
              <details className="problem-rows">
                <summary>
                  {plural(counts.invalid + counts.duplicate, 'row')} not imported
                </summary>
                <ul>
                  {rows
                    .filter((r) => r.status !== 'ready')
                    .slice(0, 200)
                    .map((r) => (
                      <li key={r.rowNumber}>
                        <span className="num">Row {r.rowNumber}</span>: {r.reason}
                        {r.lead.businessName ? <span className="muted"> ({r.lead.businessName})</span> : null}
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {step === 'destination' && (
          <div className="stack dest">
            <fieldset className="dest-group">
              <legend>List</legend>
              <label className="checkbox">
                <input type="radio" name="dest" checked={destMode === 'new'} onChange={() => setDestMode('new')} />
                <span>A new list</span>
              </label>
              {destMode === 'new' && <Input aria-label="New list name" value={newListName} onChange={(e) => setNewListName(e.target.value)} fieldClassName="dest-indent" />}
              <label className="checkbox">
                <input type="radio" name="dest" checked={destMode === 'existing'} onChange={() => setDestMode('existing')} disabled={lists.length === 0} />
                <span>Add to an existing list</span>
              </label>
              {destMode === 'existing' && (
                <Select
                  aria-label="Existing list"
                  value={existingListId}
                  onChange={(e) => setExistingListId(e.target.value)}
                  placeholder="Choose a list"
                  options={lists.map((l) => ({ value: l.id, label: `${l.name} (${l.leadCount.toLocaleString('en-US')} leads)` }))}
                  fieldClassName="dest-indent"
                />
              )}
            </fieldset>

            <fieldset className="dest-group">
              <legend>Owner</legend>
              <label className="checkbox">
                <input type="radio" name="assign" checked={assignMode === 'pool'} onChange={() => setAssignMode('pool')} />
                <span>
                  Shared pool
                  <span className="field-hint">Any caller can get these leads</span>
                </span>
              </label>
              <label className="checkbox">
                <input type="radio" name="assign" checked={assignMode === 'caller'} onChange={() => setAssignMode('caller')} disabled={callers.length === 0} />
                <span>
                  One caller
                  <span className="field-hint">Only this person gets them</span>
                </span>
              </label>
              {assignMode === 'caller' && (
                <Select
                  aria-label="Caller"
                  value={callerId}
                  onChange={(e) => setCallerId(e.target.value)}
                  placeholder="Choose a caller"
                  options={callers.map((u) => ({ value: u.id, label: u.fullName }))}
                  fieldClassName="dest-indent"
                />
              )}
              <label className="checkbox">
                <input type="radio" name="assign" checked={assignMode === 'round_robin'} onChange={() => setAssignMode('round_robin')} disabled={callers.length === 0} />
                <span>
                  Split evenly between callers
                  <span className="field-hint">Handed out in turn, one each</span>
                </span>
              </label>
              {assignMode === 'round_robin' && (
                <div className="dest-indent rr-list">
                  {callers.map((u) => (
                    <Checkbox
                      key={u.id}
                      label={u.fullName}
                      checked={rrCallers.includes(u.id)}
                      onChange={(v) => setRrCallers((xs) => (v ? [...xs, u.id] : xs.filter((x) => x !== u.id)))}
                    />
                  ))}
                  {rrCallers.length > 0 && <div className="muted adm-small">About {Math.ceil(counts.ready / rrCallers.length).toLocaleString('en-US')} leads each.</div>}
                </div>
              )}
            </fieldset>
            {destinationError && <div className="muted adm-small">{destinationError}</div>}
          </div>
        )}

        {step === 'importing' && (
          <div className="stack import-progress">
            <strong>Importing. Keep this window open.</strong>
            <div className="adm-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
              <div className="adm-progress-bar" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 5}%` }} />
            </div>
            <span className="muted">
              {progress.done.toLocaleString('en-US')} of {progress.total.toLocaleString('en-US')} leads
            </span>
          </div>
        )}

        {step === 'done' && summary && (
          <div className="stack">
            {summary.error ? (
              <div className="form-error" role="alert">
                The import stopped part-way: {summary.error}. {summary.imported > 0 ? `${plural(summary.imported, 'lead')} were saved before that.` : 'Nothing was saved.'}
              </div>
            ) : (
              <div className="adm-callout adm-callout-good">
                <IconCheck /> Import finished
              </div>
            )}
            <div className="stat-grid">
              <StatTile label="Imported" value={summary.imported.toLocaleString('en-US')} />
              <StatTile label="Already in system" value={summary.existing.toLocaleString('en-US')} sub="skipped" />
              <StatTile label="Can't import" value={summary.invalid.toLocaleString('en-US')} sub="no usable phone or name" />
              <StatTile label="Duplicates in file" value={summary.inFileDuplicates.toLocaleString('en-US')} sub="skipped" />
            </div>
            {summary.serverOnlyDuplicates > 0 && (
              <p className="muted adm-small">
                {plural(summary.serverOnlyDuplicates, 'lead')} matched a lead already in the system but {summary.precheckFailed ? "we couldn't check beforehand which rows they were" : 'were added in the last few moments'}, so they aren't listed in the skipped-rows file.
              </p>
            )}
            {finalRows.some((r) => r.status !== 'ready') && (
              <div>
                <Button icon={<IconDownload />} onClick={downloadSkipped}>
                  Download skipped rows
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
