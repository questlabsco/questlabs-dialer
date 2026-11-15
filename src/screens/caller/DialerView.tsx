/**
 * The whole dialer UI as a pure component: renders entirely from DialerState and calls
 * DialerControls. DialerScreen wires it to useDialer(); dev fixtures render it with fake data.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconAlert,
  IconCallback,
  IconPause,
  IconPhone,
  IconPhoneIncoming,
  IconPhoneOff,
  IconPlay,
  IconStop,
  PageHeader,
  SectionHeading,
  Spinner,
  StatTile,
  Textarea,
  Toolbar,
  useToast,
} from '../../components/ui';
import { errorMessage } from '../../api/Api';
import type { LeadPatch } from '../../api/Api';
import type { CallRecord, Lead, MetricsTotals, Settings } from '../../types';
import type { DialerControls, DialerSessionStats, DialerState, LineState } from '../../dialer/types';
import { formatDuration, formatDurationLong, formatNumber, formatPercent, formatPhone } from '../../lib/format';
import { CallBar } from './CallBar';
import { LeadHighlights, LeadPanel } from './LeadPanel';
import { ManualDial } from './ManualDial';
import { MicCheck } from './MicCheck';
import ScriptPanel from './ScriptPanel';
import { WrapUpPanel } from './WrapUpPanel';
import { clearCallDraft, useCallDraft, useLeadEdits, useNow } from './callerHooks';
import { isEditableTarget, isUnknownLead, manualEndedText, resolveShortcut, secondsSince, wrapUpValidation } from './dialerLogic';
import './caller.css';

export interface DialerDataSource {
  getLeadHistory(leadId: string): Promise<CallRecord[]>;
  updateLead(id: string, patch: Pick<LeadPatch, 'contactName' | 'email'>): Promise<Lead>;
}

export interface DialerViewProps {
  state: DialerState;
  controls: DialerControls;
  /** Null while loading. */
  settings: Settings | null;
  callerId: string;
  callerName: string;
  /** Today's totals for the idle screen; null while loading / unavailable. */
  statsToday: MetricsTotals | null;
  /** Callbacks due now; null while loading. */
  callbacksDue: number | null;
  data: DialerDataSource;
  /** Optional bar rendered above everything (dev fixture switcher). */
  topSlot?: ReactNode;
}

const RUNNING = new Set(['starting', 'dialing', 'connected', 'wrap_up', 'paused']);

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function SessionStrip({ session, now }: { session: DialerSessionStats; now: number }) {
  const items: [string, string][] = [
    ['Dials', formatNumber(session.dials)],
    ['Pickups', formatNumber(session.pickups)],
    ['Conversations', formatNumber(session.conversations)],
    ['Bookings', formatNumber(session.bookings)],
    ['Talk time', formatDurationLong(session.talkSeconds)],
    ['Session', formatDuration(secondsSince(session.startedAt, now))],
  ];
  return (
    <dl className="dl-strip" aria-label="This session">
      {items.map(([k, v]) => (
        <div key={k} className="dl-strip-item">
          <dt>{k}</dt>
          <dd className="num">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function LineCard({ line, now, ringSeconds }: { line: LineState; now: number; ringSeconds: number }) {
  if (line.status === 'empty' || !line.lead) {
    return (
      <div className="dl-line dl-line-empty" aria-label={`Line ${line.index + 1}: finding next lead`}>
        <span className="dl-line-no">Line {line.index + 1}</span>
        <span className="row muted dl-line-finding">
          <Spinner size={12} /> Finding next lead
        </span>
      </div>
    );
  }
  const elapsed = secondsSince(line.startedAt, now);
  const pct = ringSeconds > 0 ? Math.min(100, (elapsed / ringSeconds) * 100) : 0;
  const answered = line.status === 'answered';
  const phoneIdx = line.lead.phones.indexOf(line.phone);
  const unknown = isUnknownLead(line.lead);
  return (
    <div className={`dl-line${answered ? ' dl-line-answered' : ''}`} aria-label={line.manual ? 'Manual call' : `Line ${line.index + 1}`}>
      <span className="dl-line-no">Line {line.index + 1}</span>
      <span className="dl-line-status">
        {answered ? <Badge tone="good">Picked up</Badge> : <Badge tone="accent">Ringing</Badge>}
        {line.ring === 2 && <Badge tone="warning">2nd ring</Badge>}
      </span>
      <span className="dl-line-who">
        <span className="dl-line-business">{(!unknown && line.lead.businessName) || formatPhone(line.phone)}</span>
        <span className="dl-line-contact">
          {unknown ? <span className="muted">Not in your leads</span> : line.lead.contactName || <span className="muted">No contact name</span>}
        </span>
      </span>
      <span className="dl-line-meta">
        <span className="num">
          {formatPhone(line.phone)}
          {line.lead.phones.length > 1 && phoneIdx >= 0 && (
            <span className="muted">
              {' '}
              ({phoneIdx + 1} of {line.lead.phones.length})
            </span>
          )}
        </span>
        <span className="muted num">From {formatPhone(line.fromNumber)}</span>
      </span>
      <span className="mono dl-line-timer" aria-label="Ring time">
        {formatDuration(elapsed)}
      </span>
      {!answered && (
        <div className="dl-ringbar" aria-hidden="true">
          <div className="dl-ringbar-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function IncomingBanner({ incoming, onAnswer, onDecline, busy }: { incoming: NonNullable<DialerState['incoming']>; onAnswer: () => void; onDecline: () => void; busy: string | null }) {
  const name = incoming.lead && !isUnknownLead(incoming.lead) && incoming.lead.businessName ? incoming.lead.businessName : formatPhone(incoming.from);
  const sub = incoming.lead && !isUnknownLead(incoming.lead) ? [incoming.lead.contactName, formatPhone(incoming.from)].filter(Boolean).join(' · ') : 'Not in your leads';
  return (
    <div className="dl-incoming" role="alert">
      <IconPhoneIncoming size={18} />
      <div className="dl-incoming-text">
        <div className="dl-incoming-title">Incoming call: {name}</div>
        <div className="dl-incoming-sub">{sub}</div>
      </div>
      <div className="row">
        <Button variant="good" icon={<IconPhone size={15} />} loading={busy === 'answer'} disabled={busy !== null && busy !== 'answer'} onClick={onAnswer}>
          Answer
        </Button>
        <Button variant="secondary" loading={busy === 'decline'} disabled={busy !== null && busy !== 'decline'} onClick={onDecline}>
          Decline
        </Button>
      </div>
    </div>
  );
}

function TodayStats({ stats, callbacksDue }: { stats: MetricsTotals | null; callbacksDue: number | null }) {
  const v = (n: number | undefined, f: (x: number) => string = formatNumber) => (stats && n !== undefined ? f(n) : '-');
  return (
    <section aria-label="Today" className="dl-today">
      <SectionHeading>Today</SectionHeading>
      <div className="stat-grid dl-today-grid">
        <StatTile label="Dials" value={v(stats?.dials)} />
        <StatTile label="Pickups" value={v(stats?.pickups)} sub={stats ? `${formatPercent(stats.pickupRate)} rate` : undefined} />
        <StatTile label="Conversations" value={v(stats?.conversations)} />
        <StatTile label="Bookings" value={v(stats?.bookings)} />
        <StatTile label="Talk time" value={v(stats?.talkSeconds, formatDurationLong)} />
        <StatTile label="Callbacks due" value={callbacksDue === null ? '-' : formatNumber(callbacksDue)} sub={callbacksDue ? 'dialed first' : undefined} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export function DialerView({ state, controls, settings, callerId, callerName, statsToday, callbacksDue, data, topSlot }: DialerViewProps) {
  const toast = useToast();
  const now = useNow(1000, RUNNING.has(state.phase));
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [getEdit, setEdit] = useLeadEdits();
  // "Call a number" field; kept here so it survives the idle -> connecting -> idle round trip.
  const [manualValue, setManualValue] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  /** Number being placed by callNumber (until it rings or fails). */
  const [manualCalling, setManualCalling] = useState<string | null>(null);

  const callManual = useCallback(
    async (e164: string) => {
      setManualCalling(e164);
      setManualError(null);
      try {
        await controls.callNumber(e164);
        setManualValue('');
      } catch (e) {
        setManualError(errorMessage(e));
      } finally {
        setManualCalling(null);
      }
    },
    [controls],
  );

  const callRecordId = state.activeCall?.callRecordId ?? state.wrapUp?.callRecordId ?? null;
  const [draft, updateDraft] = useCallDraft(callRecordId);

  const baseLead = state.activeCall?.lead ?? state.wrapUp?.lead ?? null;
  const lead: Lead | null = baseLead ? { ...baseLead, ...getEdit(baseLead.id) } : null;

  // Remember which phone was used so wrap-up can still highlight it.
  const activePhone = state.activeCall ? (state.activeCall.direction === 'inbound' ? state.activeCall.fromNumber : state.activeCall.toNumber) : null;
  useEffect(() => {
    if (activePhone && draft.phoneInUse !== activePhone) updateDraft({ phoneInUse: activePhone });
  }, [activePhone, draft.phoneInUse, updateDraft]);

  useEffect(() => {
    setSaveError(null);
    setSaving(false);
  }, [callRecordId]);

  const run = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      setBusy(key);
      try {
        await fn();
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy((b) => (b === key ? null : b));
      }
    },
    [toast],
  );

  const save = useCallback(async () => {
    if (!state.wrapUp || saving) return;
    const problem = wrapUpValidation(draft.disposition, draft.callbackAt, Date.now());
    if (problem || !draft.disposition) {
      setSaveError(problem ?? 'Pick an outcome first.');
      return;
    }
    const id = state.wrapUp.callRecordId;
    const needsTime = draft.disposition === 'callback';
    setSaving(true);
    setSaveError(null);
    try {
      await controls.submitDisposition({ disposition: draft.disposition, notes: draft.notes.trim(), callbackAt: needsTime ? draft.callbackAt : null });
      clearCallDraft(id);
    } catch (e) {
      setSaveError(`Not saved: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  }, [state.wrapUp, saving, draft, controls]);

  const saveLeadField = useCallback(
    async (field: 'contactName' | 'email', value: string) => {
      if (!lead || isUnknownLead(lead)) return;
      const updated = await data.updateLead(lead.id, field === 'email' ? { email: value } : { contactName: value });
      setEdit(lead.id, field === 'email' ? { email: updated.email } : { contactName: updated.contactName });
    },
    [lead, data, setEdit],
  );

  // Keyboard shortcuts (latest handlers via ref so the listener is attached once).
  const handlers = useRef({ state, draft, save, run, controls, updateDraft });
  handlers.current = { state, draft, save, run, controls, updateDraft };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const h = handlers.current;
      const target = e.target as (Element & { isContentEditable?: boolean }) | null;
      const action = resolveShortcut({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        inEditable: isEditableTarget(target as { tagName?: string; isContentEditable?: boolean } | null),
        phase: h.state.phase,
        manualRinging: h.state.lines.some((l) => l.manual && l.status === 'ringing'),
      });
      if (!action) return;
      e.preventDefault();
      switch (action.type) {
        case 'mute':
          void h.run('mute', () => h.controls.toggleMute());
          break;
        case 'hang_up':
          void h.run('hangup', () => h.controls.hangUp());
          break;
        case 'pick':
          h.updateDraft({ disposition: action.disposition });
          break;
        case 'save':
          void h.save();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ringSeconds = settings?.ringSeconds ?? 22;
  const lines = settings?.linesPerCaller ?? 2;
  const { phase } = state;
  const manualLine = state.lines.find((l) => l.manual) ?? null;
  const manualActive = !!manualLine || !!state.activeCall?.manual || !!state.wrapUp?.manual;

  const manualDial = (
    <ManualDial
      value={manualValue}
      onChange={setManualValue}
      error={manualError}
      onError={setManualError}
      calling={manualCalling !== null}
      onCall={(e164) => void callManual(e164)}
      note={state.manualEnded ? manualEndedText(state.manualEnded.result, formatPhone(state.manualEnded.phone)) : null}
    />
  );

  let body: ReactNode;
  if (phase === 'idle') {
    body = (
      <div className="dl-grid">
        <div className="stack dl-main-col">
          <section className="dl-hero" aria-label="Start">
            <div className="dl-hero-inner">
              <Button variant="primary" size="lg" className="dl-start" icon={<IconPlay size={15} />} loading={busy === 'start'} onClick={() => void run('start', () => controls.start())}>
                Start dialing
              </Button>
              <p className="muted dl-hero-text">
                {lines === 1 ? 'Rings one lead at a time.' : `Rings ${lines} leads at once; the first pickup connects.`}
                {callbacksDue ? ' Due callbacks are dialed first.' : ''}
              </p>
            </div>
            {manualDial}
          </section>
          <TodayStats stats={statsToday} callbacksDue={callbacksDue} />
        </div>
        <div className="stack dl-side-col">
          <MicCheck />
          <ScriptPanel lead={null} callerName={callerName} />
        </div>
      </div>
    );
  } else if (phase === 'starting') {
    body = (
      <Card>
        <div className="dl-center">
          <Spinner size={22} label="Connecting" />
          <h2 className="dl-hero-title">{manualCalling ? `Calling ${formatPhone(manualCalling)}` : 'Connecting'}</h2>
          <p className="muted">{manualCalling ? 'Starting your line' : 'Starting your line and loading leads'}</p>
          <Button variant="ghost" icon={<IconStop size={15} />} loading={busy === 'stop'} onClick={() => void run('stop', () => controls.stop())}>
            Cancel
          </Button>
        </div>
      </Card>
    );
  } else if (phase === 'dialing' && manualLine) {
    const known = manualLine.lead && !isUnknownLead(manualLine.lead) ? manualLine.lead : null;
    body = (
      <div className="dl-grid">
        <div className="stack dl-main-col">
          <div className="data-panel">
            <Toolbar
              className="dl-toolbar"
              count={
                <>
                  <strong>Manual call</strong> to {formatPhone(manualLine.phone)}
                </>
              }
              right={
                <Button
                  size="sm"
                  variant="danger"
                  icon={<IconPhoneOff size={13} />}
                  aria-keyshortcuts="H"
                  loading={busy === 'hangup'}
                  onClick={() => void run('hangup', () => controls.hangUp())}
                >
                  Hang up <kbd className="dl-kbd dl-kbd-on-color">H</kbd>
                </Button>
              }
            />
            <div className="dl-lines">
              <div className="dl-lines-head" aria-hidden="true">
                <span>Line</span>
                <span>Status</span>
                <span>Business</span>
                <span>Phone</span>
                <span className="align-right">Ring</span>
              </div>
              <LineCard line={manualLine} now={now} ringSeconds={ringSeconds} />
            </div>
          </div>
        </div>
        <div className="stack dl-side-col">
          <ScriptPanel lead={known} callerName={callerName} />
        </div>
      </div>
    );
  } else if (phase === 'dialing') {
    body = (
      <div className="dl-grid">
        <div className="stack dl-main-col">
          <div className="data-panel">
            <Toolbar
              className="dl-toolbar"
              count={
                state.queueEmpty ? (
                  <strong>Nothing to dial</strong>
                ) : (
                  <>
                    Dialing <strong>{state.lines.filter((l) => l.status !== 'empty').length}</strong> of {state.lines.length} lines
                  </>
                )
              }
              right={
                <>
                  <Button size="sm" icon={<IconPause size={13} />} loading={busy === 'pause'} onClick={() => void run('pause', () => controls.pause())}>
                    Pause
                  </Button>
                  <Button size="sm" variant="ghost" icon={<IconStop size={13} />} loading={busy === 'stop'} onClick={() => void run('stop', () => controls.stop())}>
                    Stop
                  </Button>
                </>
              }
            />
            {state.queueEmpty ? (
              <EmptyState icon={<IconCallback size={32} />} title="No leads left to dial" message="Everyone available today has been called. Scheduled callbacks ring when due." />
            ) : (
              <div className="dl-lines">
                <div className="dl-lines-head" aria-hidden="true">
                  <span>Line</span>
                  <span>Status</span>
                  <span>Business</span>
                  <span>Phone</span>
                  <span className="align-right">Ring</span>
                </div>
                {state.lines.map((l) => (
                  <LineCard key={l.index} line={l} now={now} ringSeconds={ringSeconds} />
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="stack dl-side-col">
          <ScriptPanel lead={null} callerName={callerName} />
        </div>
      </div>
    );
  } else if (phase === 'connected' && state.activeCall && lead) {
    const call = state.activeCall;
    body = (
      <>
        <CallBar
          call={call}
          businessName={lead.businessName}
          contactName={lead.contactName}
          email={lead.email}
          now={now}
          hangingUp={busy === 'hangup'}
          onToggleMute={() => void run('mute', () => controls.toggleMute())}
          onHangUp={() => void run('hangup', () => controls.hangUp())}
          onDigit={(d) => void controls.sendDigits(d).catch((e) => toast.error(errorMessage(e)))}
        />
        <LeadHighlights lead={lead} phoneInUse={activePhone} />
        <div className="dl-grid dl-grid-even">
          <ScriptPanel lead={lead} callerName={callerName} />
          <Card title="Notes" actions={<span className="muted dl-small">Kept for wrap-up</span>} className="dl-notes-card">
            <Textarea
              aria-label="Call notes"
              rows={10}
              value={draft.notes}
              placeholder="Decision maker, best time, objections"
              onChange={(e) => updateDraft({ notes: e.target.value })}
            />
          </Card>
        </div>
        <LeadPanel lead={lead} phoneInUse={activePhone} callerId={callerId} data={data} currentCallRecordId={call.callRecordId} onSaveField={saveLeadField} />
      </>
    );
  } else if (phase === 'wrap_up' && state.wrapUp && lead) {
    body = (
      <>
      <LeadHighlights lead={lead} phoneInUse={draft.phoneInUse} />
      <div className="dl-grid">
        <div className="stack dl-main-col">
          <WrapUpPanel
            key={state.wrapUp.callRecordId}
            lead={lead}
            talkSeconds={state.wrapUp.talkSeconds}
            draft={draft}
            onDraft={(patch) => {
              updateDraft(patch);
              if (saveError) setSaveError(null);
            }}
            settings={settings}
            now={now}
            saving={saving}
            error={saveError}
            onSave={() => void save()}
            pauseRequested={state.pauseRequested}
            onRequestPause={() => void run('pause', () => controls.pause())}
            onSaveEmail={(email) => saveLeadField('email', email)}
            manual={!!state.wrapUp.manual}
          />
        </div>
        <div className="stack dl-side-col">
          <LeadPanel lead={lead} phoneInUse={draft.phoneInUse} callerId={callerId} data={data} currentCallRecordId={state.wrapUp.callRecordId} onSaveField={saveLeadField} />
        </div>
      </div>
      </>
    );
  } else if (phase === 'paused') {
    body = (
      <Card>
        <div className="dl-center">
          <h2 className="dl-hero-title">Paused</h2>
          <p className="muted">No new calls are being placed.</p>
          <div className="row">
            <Button variant="primary" size="lg" icon={<IconPlay size={16} />} loading={busy === 'resume'} onClick={() => void run('resume', () => controls.resume())}>
              Resume
            </Button>
            <Button size="lg" icon={<IconStop size={16} />} loading={busy === 'stop'} onClick={() => void run('stop', () => controls.stop())}>
              Stop
            </Button>
          </div>
          {manualDial}
        </div>
      </Card>
    );
  } else if (phase === 'error') {
    body = (
      <Card>
        <div className="dl-center">
          <h2 className="dl-hero-title dl-error-text">
            <IconAlert size={18} /> Dialer stopped
          </h2>
          <p className="dl-error-message">{state.error || 'Something went wrong.'}</p>
          <div className="row">
            <Button variant="primary" icon={<IconPlay size={16} />} loading={busy === 'start'} onClick={() => void run('start', () => controls.start())}>
              Try again
            </Button>
            <Button icon={<IconStop size={16} />} loading={busy === 'stop'} onClick={() => void run('stop', () => controls.stop())}>
              Stop
            </Button>
          </div>
        </div>
      </Card>
    );
  } else {
    // Inconsistent snapshot (e.g. connected without activeCall): show a neutral state.
    body = (
      <Card>
        <div className="dl-center">
          <Spinner size={24} label="Working" />
          <p className="muted">Working</p>
        </div>
      </Card>
    );
  }

  const statusBadge: Record<DialerState['phase'], ReactNode> = {
    idle: <Badge>Not dialing</Badge>,
    starting: <Badge tone="accent">Connecting</Badge>,
    dialing: <Badge tone="accent">{manualLine ? 'Calling' : 'Dialing'}</Badge>,
    connected: <Badge tone="good">On a call</Badge>,
    wrap_up: <Badge tone="warning">Wrap-up</Badge>,
    paused: <Badge>Paused</Badge>,
    error: <Badge tone="critical">Stopped</Badge>,
  };

  const showStrip = phase !== 'idle' && state.session.startedAt !== null && !manualActive && !(phase === 'starting' && manualCalling);

  return (
    <div className="screen dl-screen">
      <PageHeader
        title="Dialer"
        subtitle={`${callerName} · ${lines} ${lines === 1 ? 'line' : 'lines'} · ${ringSeconds} s ring`}
        actions={
          <>
            {state.pauseRequested && phase !== 'paused' && <Badge tone="warning">Pausing after this call</Badge>}
            {statusBadge[phase]}
          </>
        }
      />
      {topSlot}
      {state.incoming && (
        <IncomingBanner
          incoming={state.incoming}
          busy={busy === 'answer' || busy === 'decline' ? busy : null}
          onAnswer={() => void run('answer', () => controls.answerIncoming())}
          onDecline={() => void run('decline', () => controls.declineIncoming())}
        />
      )}
      {showStrip && <SessionStrip session={state.session} now={now} />}
      {body}
    </div>
  );
}
