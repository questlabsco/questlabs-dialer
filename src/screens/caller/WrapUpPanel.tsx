import { useState } from 'react';
import { Button, Card, Checkbox, Textarea } from '../../components/ui';
import { DISPOSITIONS, dispositionInfo, type Disposition, type Lead, type Settings } from '../../types';
import { BookMeetingButton } from './Booking';
import { formatDateTime, formatDuration, formatRelative, fromDateTimeLocalValue, toDateTimeLocalValue } from '../../lib/format';
import { callbackQuickPicks, isFutureTime, isUnknownLead, type QuickPickId } from './dialerLogic';
import type { CallDraft } from './callerHooks';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
export const SAVE_SHORTCUT_LABEL = IS_MAC ? 'Cmd+Enter' : 'Ctrl+Enter';

// ---------------------------------------------------------------------------
// Callback time picker
// ---------------------------------------------------------------------------

function CallbackPicker({ value, onChange, now }: { value: string | null; onChange: (iso: string | null) => void; now: number }) {
  const [mode, setMode] = useState<QuickPickId | 'custom' | null>(value ? 'custom' : null);
  const picks = callbackQuickPicks(now);
  const future = isFutureTime(value, now);
  return (
    <fieldset className="dl-fieldset">
      <legend className="field-label">Call back</legend>
      <div className="row dl-wrap">
        {picks.map((p) => (
          <Button
            key={p.id}
            size="sm"
            variant={mode === p.id ? 'primary' : 'secondary'}
            aria-pressed={mode === p.id}
            onClick={() => {
              setMode(p.id);
              onChange(p.iso);
            }}
          >
            {p.label}
          </Button>
        ))}
        <Button size="sm" variant={mode === 'custom' ? 'primary' : 'secondary'} aria-pressed={mode === 'custom'} onClick={() => setMode('custom')}>
          Pick a time
        </Button>
      </div>
      {mode === 'custom' && (
        <input
          className="input dl-datetime"
          type="datetime-local"
          aria-label="Callback date and time"
          value={toDateTimeLocalValue(value)}
          min={toDateTimeLocalValue(new Date(now).toISOString())}
          onChange={(e) => onChange(fromDateTimeLocalValue(e.target.value))}
          autoFocus
        />
      )}
      {value ? (
        future ? (
          <div className="field-hint">
            {formatDateTime(value)} ({formatRelative(value, now)}). Dialed first when due.
          </div>
        ) : (
          <div className="field-error" role="alert">
            That time has passed. Pick a future time.
          </div>
        )
      ) : (
        <div className="field-hint">Pick a time to save the callback</div>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Wrap-up panel
// ---------------------------------------------------------------------------

export interface WrapUpPanelProps {
  lead: Lead;
  talkSeconds: number;
  draft: CallDraft;
  onDraft: (patch: Partial<CallDraft>) => void;
  /** No longer read here (the booking button loads the link itself); kept so callers compile. */
  settings?: Settings | null;
  now: number;
  saving: boolean;
  /** Validation or save error to show above the Save button. */
  error: string | null;
  onSave: () => void;
  pauseRequested: boolean;
  onRequestPause: () => void;
  /** No longer used here (email is edited in the lead details); kept so callers compile. */
  onSaveEmail?: (email: string) => Promise<void>;
}

export function WrapUpPanel({ lead, talkSeconds, draft, onDraft, now, saving, error, onSave, pauseRequested, onRequestPause }: WrapUpPanelProps) {
  const selected = draft.disposition ? dispositionInfo(draft.disposition) : null;
  const pick = (d: Disposition) => onDraft({ disposition: d });
  const unknown = isUnknownLead(lead);
  const who = unknown ? 'this caller' : lead.businessName || 'this lead';

  return (
    <Card title="Outcome" actions={<span className="muted dl-small">{who} · {formatDuration(talkSeconds)}</span>} className="dl-wrapup-card">
      <div className="stack dl-wrapup">
        <div className="dl-outcomes" role="radiogroup" aria-label="Outcome">
          {DISPOSITIONS.map((d) => {
            const active = draft.disposition === d.value;
            return (
              <button
                key={d.value}
                type="button"
                role="radio"
                aria-checked={active}
                aria-keyshortcuts={d.hotkey}
                className={`dl-outcome tone-${d.tone}${active ? ' active' : ''}`}
                onClick={() => pick(d.value)}
              >
                <span className="dl-outcome-label">{d.label}</span>
                <kbd className="dl-kbd">{d.hotkey}</kbd>
              </button>
            );
          })}
        </div>

        {selected?.requiresCallbackAt && <CallbackPicker value={draft.callbackAt} onChange={(iso) => onDraft({ callbackAt: iso })} now={now} />}
        {selected?.value === 'booked' && (
          <div className="dl-booking">
            <BookMeetingButton name={unknown ? '' : lead.contactName} email={unknown ? '' : lead.email} businessName={unknown ? '' : lead.businessName} variant="secondary" />
            {!unknown && lead.email && (
              <span className="muted dl-small">
                Prefilled for {lead.contactName ? `${lead.contactName}, ` : ''}
                {lead.email}
              </span>
            )}
          </div>
        )}

        <Textarea label="Notes" rows={4} value={draft.notes} placeholder="What they said, what the next call should know" onChange={(e) => onDraft({ notes: e.target.value })} />

        <Checkbox
          label="Pause after this call"
          checked={pauseRequested}
          disabled={pauseRequested}
          onChange={(checked) => {
            if (checked) onRequestPause();
          }}
          hint={pauseRequested ? 'Dialing pauses when you save' : undefined}
        />

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}

        <div className="row dl-wrap">
          <Button variant="primary" size="lg" loading={saving} onClick={onSave} aria-keyshortcuts={IS_MAC ? 'Meta+Enter' : 'Control+Enter'}>
            {pauseRequested ? 'Save & pause' : 'Save & continue'}
          </Button>
          <span className="muted dl-small">
            <kbd className="dl-kbd">{SAVE_SHORTCUT_LABEL}</kbd> save · <kbd className="dl-kbd">1</kbd>-<kbd className="dl-kbd">7</kbd> outcome
          </span>
        </div>
      </div>
    </Card>
  );
}
