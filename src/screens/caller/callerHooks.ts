/**
 * Small hooks for the caller screens: a ticking clock, per-call drafts (notes typed during the call
 * carry into wrap-up and survive switching screens) and inline lead edits made during a call.
 */
import { useCallback, useEffect, useReducer, useState } from 'react';
import type { Disposition } from '../../types';

/** Current time in ms, re-rendering every `intervalMs` while `active`. */
export function useNow(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, active]);
  return now;
}

// ---------------------------------------------------------------------------
// Per-call drafts (module-level so they outlive the screen)
// ---------------------------------------------------------------------------

export interface CallDraft {
  notes: string;
  disposition: Disposition | null;
  callbackAt: string | null;
  /** The lead phone that was in use during the call (for highlighting in wrap-up). */
  phoneInUse: string | null;
}

const EMPTY_DRAFT: CallDraft = { notes: '', disposition: null, callbackAt: null, phoneInUse: null };
const drafts = new Map<string, CallDraft>();

export function clearCallDraft(callRecordId: string, callerId: string): void {
  try { localStorage.removeItem('call-draft:'+callerId+':'+callRecordId); } catch { /* storage unavailable */ }
  drafts.delete(callRecordId);
}

/** `[draft, update]` for one call (keyed by CallRecord id). */
export function useCallDraft(callRecordId: string | null, callerId: string): [CallDraft, (patch: Partial<CallDraft>) => void] {
  const [, force] = useReducer((x: number) => x + 1, 0);
  if(callRecordId && !drafts.has(callRecordId)) {
    try {
      const saved=localStorage.getItem('call-draft:'+callerId+':'+callRecordId);
      if(saved) drafts.set(callRecordId,{...EMPTY_DRAFT,...JSON.parse(saved)});
    } catch { /* storage unavailable */ }
  }
  const draft = (callRecordId && drafts.get(callRecordId)) || EMPTY_DRAFT;
  const update = useCallback(
    (patch: Partial<CallDraft>) => {
      if (!callRecordId) return;
      drafts.set(callRecordId, { ...(drafts.get(callRecordId) ?? EMPTY_DRAFT), ...patch });
      try { localStorage.setItem('call-draft:'+callerId+':'+callRecordId,JSON.stringify(drafts.get(callRecordId))); } catch { /* keep in memory */ }
      // Keep the map small: drop the oldest entries.
      while (drafts.size > 30) {
        const first = drafts.keys().next().value;
        if (first === undefined) break;
        drafts.delete(first);
      }
      force();
    },
    [callRecordId,callerId],
  );
  return [draft, update];
}

// ---------------------------------------------------------------------------
// Inline lead edits (contact name / email saved with api.updateLead)
// ---------------------------------------------------------------------------

export interface LeadEdit {
  contactName?: string;
  email?: string;
}

const leadEdits = new Map<string, LeadEdit>();

export function useLeadEdits(): [(leadId: string) => LeadEdit | undefined, (leadId: string, edit: LeadEdit) => void] {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const get = useCallback((leadId: string) => leadEdits.get(leadId), []);
  const set = useCallback((leadId: string, edit: LeadEdit) => {
    leadEdits.set(leadId, { ...(leadEdits.get(leadId) ?? {}), ...edit });
    while (leadEdits.size > 50) {
      const first = leadEdits.keys().next().value;
      if (first === undefined) break;
      leadEdits.delete(first);
    }
    force();
  }, []);
  return [get, set];
}
