/**
 * Caller script panel: shows the caller's script (their own copy, or the team script from Settings)
 * with placeholders filled from the current lead, and lets them edit their own copy in place.
 *
 * Mount it anywhere (idle, dialing, live call). All mounted panels share one module-level store, so
 * a save in one panel shows up in every other panel without a reload, and an unsaved edit survives
 * the panel being swapped (e.g. idle -> connected).
 */
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { api, errorMessage } from '../../api';
import type { MyScript } from '../../api/Api';
import type { Lead } from '../../types';
import { Button, ConfirmDialog, Spinner } from '../../components/ui';
import { isUnknownLead, renderScript, type ScriptVars } from './dialerLogic';
import './scriptPanel.css';

export interface ScriptPanelProps {
  lead?: Lead | null;
  callerName: string;
  compact?: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (tested in scriptPanel.test.ts)
// ---------------------------------------------------------------------------

/** Placeholders the script may contain (same set renderScript() replaces). */
export const SCRIPT_PLACEHOLDERS: readonly { token: string; label: string }[] = [
  { token: '{contactName}', label: 'contact name' },
  { token: '{businessName}', label: 'business name' },
  { token: '{callerName}', label: 'your name' },
];

/** Same variables the dialer has always used: the lead's names, or bracketed placeholders without a (known) lead. */
export function scriptVarsFor(lead: Lead | null | undefined, callerName: string): Partial<ScriptVars> {
  if (lead && !isUnknownLead(lead)) return { contactName: lead.contactName, businessName: lead.businessName, callerName };
  return { contactName: '[contact name]', businessName: '[business name]', callerName };
}

/** Inserts `token` over the selection [start, end) and returns the new text and caret position. */
export function insertToken(text: string, start: number, end: number, token: string): { text: string; caret: number } {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  return { text: text.slice(0, s) + token + text.slice(e), caret: s + token.length };
}

/** What a Save should do with the editor text. */
export type SaveIntent = { kind: 'empty' } | { kind: 'unchanged' } | { kind: 'save'; script: string };

export function saveIntent(draft: string, current: MyScript): SaveIntent {
  if (!draft.trim()) return { kind: 'empty' };
  if (draft === current.script) return { kind: 'unchanged' };
  return { kind: 'save', script: draft };
}

// ---------------------------------------------------------------------------
// Shared store
// ---------------------------------------------------------------------------

export interface ScriptSource {
  getMyScript(): Promise<MyScript>;
  saveMyScript(script: string | null): Promise<void>;
}

export interface ScriptSnapshot {
  /** Last known script, or null before the first load. */
  value: MyScript | null;
  loading: boolean;
  /** Load error (only meaningful while value is null). */
  loadError: string | null;
  /** Unsaved editor text; non-null means "editing". */
  draft: string | null;
  /** Which mounted panel shows the editor (null = the next panel to mount picks it up). */
  editor: string | null;
}

export interface ScriptStore {
  getSnapshot(): ScriptSnapshot;
  subscribe(listener: () => void): () => void;
  /** Loads (or revalidates) the script. Concurrent calls share one request. */
  load(opts?: { force?: boolean }): Promise<void>;
  /** Saves a personal copy (null/blank = back to the team script). Rejects on failure; the draft is kept. */
  save(script: string | null): Promise<void>;
  /** Sets the unsaved text. Passing `editor` also makes that panel the one showing the editor. */
  setDraft(draft: string | null, editor?: string): void;
  /** Makes `editor` show the open draft if no other panel does (or `force`). */
  claim(editor: string, force?: boolean): void;
  /** A panel unmounted: keep the draft, let the next panel pick it up. */
  release(editor: string): void;
  /** Forget everything (e.g. on sign-out / user change). */
  clear(): void;
}

const REVALIDATE_MS = 30_000;

export function createScriptStore(source: ScriptSource, now: () => number = () => Date.now()): ScriptStore {
  let snap: ScriptSnapshot = { value: null, loading: false, loadError: null, draft: null, editor: null };
  let inflight: Promise<void> | null = null;
  let loadedAt = 0;
  /** Bumped on every save/clear so a slower, older load cannot overwrite newer data. */
  let generation = 0;
  const listeners = new Set<() => void>();

  const set = (patch: Partial<ScriptSnapshot>) => {
    snap = { ...snap, ...patch };
    for (const l of listeners) l();
  };

  const store: ScriptStore = {
    getSnapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load(opts) {
      if (inflight) return inflight;
      if (!opts?.force && snap.value && now() - loadedAt < REVALIDATE_MS) return Promise.resolve();
      const gen = generation;
      set({ loading: true });
      inflight = source
        .getMyScript()
        .then(
          (value) => {
            if (gen !== generation) return;
            loadedAt = now();
            set({ value, loading: false, loadError: null });
          },
          (e: unknown) => {
            if (gen !== generation) return;
            set({ loading: false, loadError: errorMessage(e) });
          },
        )
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    async save(script) {
      const value = script != null && script.trim() ? script : null;
      await source.saveMyScript(value);
      generation += 1;
      inflight = null;
      const team = snap.value?.teamScript;
      if (team === undefined) {
        set({ draft: null, editor: null });
        await store.load({ force: true });
        return;
      }
      loadedAt = now();
      set({
        value: value ? { script: value, isPersonal: true, teamScript: team } : { script: team, isPersonal: false, teamScript: team },
        loading: false,
        loadError: null,
        draft: null,
        editor: null,
      });
    },
    setDraft(draft, editor) {
      const nextEditor = draft === null ? null : (editor ?? snap.editor);
      if (draft === snap.draft && nextEditor === snap.editor) return;
      set({ draft, editor: nextEditor });
    },
    claim(editor, force = false) {
      if (snap.draft === null || snap.editor === editor) return;
      if (snap.editor !== null && !force) return;
      set({ editor });
    },
    release(editor) {
      if (snap.editor === editor) set({ editor: null });
    },
    clear() {
      generation += 1;
      inflight = null;
      loadedAt = 0;
      set({ value: null, loading: false, loadError: null, draft: null, editor: null });
    },
  };
  return store;
}

let sharedStore: ScriptStore | null = null;

/** The app-wide store, bound to `api`. Cleared whenever the signed-in user changes. */
export function getScriptStore(): ScriptStore {
  if (!sharedStore) {
    const store = createScriptStore(api);
    sharedStore = store;
    let lastUser: string | null | undefined;
    api.onAuthChange((p) => {
      const id = p?.id ?? null;
      if (lastUser !== undefined && id === lastUser) return;
      lastUser = id;
      store.clear();
    });
  }
  return sharedStore;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ScriptPanel({ lead, callerName, compact = false }: ScriptPanelProps) {
  const store = getScriptStore();
  const { value, loading, loadError, draft, editor } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const panelId = useId();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const editing = draft !== null && editor === panelId;

  useEffect(() => {
    void store.load();
  }, [store]);

  // An unsaved edit follows the caller when panels are swapped (e.g. idle -> connected).
  useEffect(() => {
    if (draft !== null && editor === null) store.claim(panelId);
  }, [draft, editor, panelId, store]);
  useEffect(() => () => store.release(panelId), [panelId, store]);

  // Focus the editor when it opens (only on the transition into edit mode).
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (editing && !wasEditing.current) textRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const startEdit = () => {
    if (!value) return;
    setSaveError(null);
    if (draft !== null) store.claim(panelId, true);
    else store.setDraft(value.script, panelId);
  };

  const cancel = useCallback(() => {
    if (saving) return;
    setSaveError(null);
    store.setDraft(null);
  }, [saving, store]);

  const save = async () => {
    if (!value || draft === null || saving) return;
    const intent = saveIntent(draft, value);
    if (intent.kind === 'empty') {
      setSaveError(value.isPersonal ? 'The script is empty. Type something, or use "Reset to team script".' : 'The script is empty.');
      return;
    }
    if (intent.kind === 'unchanged') {
      setSaveError(null);
      store.setDraft(null);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await store.save(intent.script);
    } catch (e) {
      setSaveError(`Couldn't save: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await store.save(null);
      setConfirmReset(false);
    } catch (e) {
      setConfirmReset(false);
      setSaveError(`Couldn't reset: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const insert = (token: string) => {
    const el = textRef.current;
    if (draft === null) return;
    const start = el ? el.selectionStart : draft.length;
    const end = el ? el.selectionEnd : draft.length;
    const next = insertToken(draft, start, end, token);
    store.setDraft(next.text);
    requestAnimationFrame(() => {
      const t = textRef.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(next.caret, next.caret);
    });
  };

  const onEditorKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };

  let body;
  if (!value) {
    body = loadError ? (
      <div className="sp-status" role="alert">
        <span className="sp-error">Couldn't load the script: {loadError}</span>
        <Button size="sm" variant="ghost" onClick={() => void store.load({ force: true })} loading={loading}>
          Retry
        </Button>
      </div>
    ) : (
      <div className="sp-status muted">
        <Spinner size={14} /> Loading script
      </div>
    );
  } else if (editing) {
    body = (
      <div className="sp-editor">
        <textarea
          ref={textRef}
          className="textarea sp-textarea"
          aria-label="Edit your script"
          value={draft ?? ''}
          onChange={(e) => store.setDraft(e.target.value)}
          onKeyDown={onEditorKeyDown}
          disabled={saving}
          spellCheck
        />
        <div className="sp-placeholders">
          <span className="muted">Placeholders:</span>
          {SCRIPT_PLACEHOLDERS.map((p) => (
            <button
              key={p.token}
              type="button"
              className="sp-token"
              title={`Insert ${p.label}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(p.token)}
              disabled={saving}
            >
              {p.token}
            </button>
          ))}
        </div>
        {saveError && (
          <div className="sp-error" role="alert">
            {saveError}
          </div>
        )}
        <div className="sp-actions">
          <Button size="sm" variant="primary" onClick={() => void save()} loading={saving}>
            Save
          </Button>
          <Button size="sm" onClick={cancel} disabled={saving}>
            Cancel
          </Button>
          {value.isPersonal && (
            <Button size="sm" variant="ghost" className="sp-reset" onClick={() => setConfirmReset(true)} disabled={saving}>
              Reset to team script
            </Button>
          )}
        </div>
      </div>
    );
  } else if (!value.script.trim()) {
    body = <p className="muted sp-empty">No script yet. Admins set the team script in Settings, or click Edit to write your own.</p>;
  } else {
    body = <div className="sp-text">{renderScript(value.script, scriptVarsFor(lead, callerName))}</div>;
  }

  return (
    <section className={`sp${compact ? ' sp-compact' : ''}${editing ? ' sp-editing' : ''}`} aria-label="Script">
      <header className="sp-head">
        <h3 className="sp-title">Script</h3>
        {value && (
          <span className={`sp-marker${value.isPersonal ? ' sp-marker-mine' : ''}`} title={value.isPersonal ? 'You are seeing your own copy of the script' : 'You are seeing the team script'}>
            {value.isPersonal ? 'Your version' : 'Team script'}
          </span>
        )}
        {value && !editing && (
          <Button size="sm" variant="ghost" className="sp-edit" onClick={startEdit}>
            Edit
          </Button>
        )}
      </header>
      {!editing && saveError && (
        <div className="sp-error" role="alert">
          {saveError}
        </div>
      )}
      <div className="sp-body">{body}</div>
      <ConfirmDialog
        open={confirmReset}
        title="Reset to team script?"
        message="Your own version of the script will be deleted and you'll see the team script again. This can't be undone."
        confirmLabel="Reset"
        danger
        busy={saving}
        onConfirm={() => void reset()}
        onCancel={() => setConfirmReset(false)}
      />
    </section>
  );
}
