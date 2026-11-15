/** Numbers screen: "Phone setup" checklist for Telnyx and the numbers found on the Telnyx account. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../../../api';
import { Button, ConfirmDialog, HelpTip, IconAlert, IconCheck, IconClose, IconExternal, IconInfo, IconRefresh, Spinner, useToast } from '../../../components/ui';
import { openExternal } from '../../../lib/desktop';
import { formatPhone } from '../../../lib/format';
import type { TelnyxStatusResult } from '../../../telephony/telnyxAdmin';
import { loadPhoneSetupClient, type PhoneSetupClient } from './phoneSetupClient';
import {
  classifyPhoneError,
  groupNumbers,
  limitView,
  markAssigned,
  otherNumbersText,
  plainPhoneError,
  setupResultView,
  statusErrorView,
  statusView,
  supabaseSecretsUrl,
  syncSummary,
  TELNYX_API_KEYS_URL,
  TELNYX_BUY_NUMBERS_URL,
  type AccountNumber,
  type NumberGroups,
  type SetupResultView,
  type SetupView,
} from './phoneSetupLogic';

type StatusLoad = { state: 'loading' } | { state: 'ok'; data: TelnyxStatusResult } | { state: 'error'; message: string };

export interface PhoneSetupState {
  /** undefined while loading; null in demo mode (no backend). */
  client: PhoneSetupClient | null | undefined;
  status: StatusLoad;
  view: SetupView | null;
  checking: boolean;
  check: () => Promise<void>;
  settingUp: boolean;
  setupResult: SetupResultView | null;
  setupError: string;
  runSetup: () => Promise<void>;
  groups: NumberGroups | null;
  syncing: boolean;
  sync: () => Promise<void>;
  assigning: string | null;
  assignErrors: Record<string, string>;
  assign: (n: AccountNumber) => Promise<void>;
}

/** All Phone setup state; `onNumbersChanged` reloads the numbers table. */
export function usePhoneSetup(onNumbersChanged: () => Promise<void> | void): PhoneSetupState {
  const toast = useToast();
  const [client, setClient] = useState<PhoneSetupClient | null | undefined>(undefined);
  const [status, setStatus] = useState<StatusLoad>({ state: 'loading' });
  const [checking, setChecking] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [setupResult, setSetupResult] = useState<SetupResultView | null>(null);
  const [setupError, setSetupError] = useState('');
  const [groups, setGroups] = useState<NumberGroups | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [assignErrors, setAssignErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    loadPhoneSetupClient().then(
      (c) => alive && setClient(c),
      () => alive && setClient(null),
    );
    return () => {
      alive = false;
    };
  }, []);

  const check = useCallback(async () => {
    if (!client) return;
    setChecking(true);
    try {
      setStatus({ state: 'ok', data: await client.status() });
    } catch (e) {
      setStatus({ state: 'error', message: errorMessage(e) });
    } finally {
      setChecking(false);
    }
  }, [client]);

  useEffect(() => {
    if (client) void check();
  }, [client, check]);

  const view = useMemo(() => (status.state === 'ok' ? statusView(status.data) : status.state === 'error' ? statusErrorView(status.message) : null), [status]);

  const runSetup = async () => {
    if (!client) return;
    setSettingUp(true);
    setSetupError('');
    setSetupResult(null);
    try {
      setSetupResult(setupResultView(await client.setup()));
    } catch (e) {
      setSetupError(errorMessage(e));
    } finally {
      setSettingUp(false);
    }
    await check();
  };

  const sync = async () => {
    if (!client) return;
    setSyncing(true);
    try {
      const r = await client.sync();
      setGroups(groupNumbers(r));
      setAssignErrors({});
      toast.success(syncSummary(r));
      await onNumbersChanged();
    } catch (e) {
      toast.error(plainPhoneError(errorMessage(e)));
    } finally {
      setSyncing(false);
    }
  };

  const assign = async (n: AccountNumber) => {
    if (!client) return;
    setAssigning(n.providerId);
    setAssignErrors(({ [n.providerId]: _, ...rest }) => rest);
    try {
      const r = await client.assign(n.providerId);
      setGroups((g) => (g ? markAssigned(g, n.providerId) : g));
      toast.success(r.alreadyAssigned ? `${formatPhone(n.number)} was already on the dialer.` : `${formatPhone(n.number)} is now on the dialer. Warm-up starts today.`);
      await onNumbersChanged();
      void check();
    } catch (e) {
      setAssignErrors((m) => ({ ...m, [n.providerId]: plainPhoneError(errorMessage(e)) }));
    } finally {
      setAssigning(null);
    }
  };

  return { client, status, view, checking, check, settingUp, setupResult, setupError, runSetup, groups, syncing, sync, assigning, assignErrors, assign };
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function Mark({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="ps-mark ps-mark-ok">
      <IconCheck size={13} strokeWidth={2.6} />
      OK
    </span>
  ) : (
    <span className="ps-mark ps-mark-fail">
      <IconClose size={13} strokeWidth={2.6} />
      Fix
    </span>
  );
}

function ExtLink({ href, children }: { href: string; children: string }) {
  return (
    <button type="button" className="ps-link" onClick={() => openExternal(href)} title={href}>
      {children}
      <IconExternal size={12} />
    </button>
  );
}

export function PhoneSetupSection({ ps, activeCallers, linesPerCaller }: { ps: PhoneSetupState; activeCallers: number | null; linesPerCaller: number | null }) {
  const [expanded, setExpanded] = useState(false);
  const { client, status, view } = ps;

  const title = (
    <h2 className="ps-title" id="ps-title">
      Phone setup
      <HelpTip text="Calls go out through your Telnyx account. This checks that the dialer's own parts on Telnyx are in place. It never changes or removes anything else on the account, such as your Vapi app and its numbers." />
    </h2>
  );

  if (client === null) {
    return (
      <section className="ps" aria-labelledby="ps-title">
        <div className="ps-head">
          {title}
          <span className="ps-summary muted">Needs the real server</span>
        </div>
        <div className="ps-body">
          <p className="ps-text">This is the demo, which has no server and no Telnyx account behind it, so there is nothing to set up here. Phone setup works in the app connected to your Supabase server.</p>
        </div>
      </section>
    );
  }

  if (client === undefined || status.state === 'loading' || !view) {
    return (
      <section className="ps" aria-labelledby="ps-title" aria-busy>
        <div className="ps-head">
          {title}
          <span className="ps-summary muted">
            <Spinner size={13} /> Checking Telnyx
          </span>
        </div>
      </section>
    );
  }

  const data = status.state === 'ok' ? status.data : null;
  const limit = data && activeCallers !== null && linesPerCaller !== null && view.stage !== 'no_key' && view.stage !== 'bad_key' ? limitView(data.concurrentCallLimit, activeCallers, linesPerCaller) : null;
  const collapsed = view.collapsible && !expanded && !ps.setupResult && !ps.setupError;
  const lowLimit = limit?.state === 'low';
  const summaryTone = view.stage === 'ok' ? 'ok' : view.stage === 'server_off' || view.stage === 'error' ? 'info' : 'fail';
  const canSetup = view.stage !== 'server_off';
  const dialerCount = data?.numbers?.dialer ?? null;

  const actions = (
    <div className="ps-actions">
      {view.collapsible && (
        <Button size="sm" variant="ghost" onClick={() => setExpanded((x) => !x)} aria-expanded={!collapsed}>
          {collapsed ? 'Show details' : 'Hide details'}
        </Button>
      )}
      <Button size="sm" icon={<IconRefresh size={13} />} loading={ps.checking && !ps.settingUp} disabled={ps.settingUp} onClick={() => void ps.check()}>
        Check again
      </Button>
      {canSetup && (
        <Button
          size="sm"
          variant={view.stage === 'ok' ? 'secondary' : 'primary'}
          loading={ps.settingUp}
          disabled={ps.checking}
          onClick={() => void ps.runSetup()}
          title="Finds or creates the dialer's own Telnyx parts (named Quest Labs Dialer) and fixes their settings. Safe to run again. Never buys numbers or touches other apps."
        >
          Set up Telnyx
        </Button>
      )}
    </div>
  );

  return (
    <section className="ps" aria-labelledby="ps-title">
      <div className="ps-head">
        {title}
        <span className="ps-summary-wrap" role="status">
          <span className={`ps-summary ps-summary-${summaryTone}`}>
            {summaryTone === 'ok' ? <IconCheck size={13} strokeWidth={2.6} /> : summaryTone === 'fail' ? <IconClose size={13} strokeWidth={2.6} /> : <IconInfo size={13} />}
            {view.summary}
          </span>
          {view.stage === 'ok' && dialerCount !== null && <span className="ps-summary-sub">{dialerCount === 1 ? '1 number' : `${dialerCount} numbers`} on the dialer</span>}
          {view.stage === 'ok' && lowLimit && (
            <span className="ps-summary-warn">
              <IconAlert size={13} />
              Call limit too low
            </span>
          )}
          {data && <span className="ps-checked">Checked {timeOf(data.checkedAt)}</span>}
        </span>
        {actions}
      </div>

      {!collapsed && (
        <div className="ps-body">
          {ps.setupError && <SetupErrorNote message={ps.setupError} />}
          {ps.setupResult && <SetupResultNote r={ps.setupResult} />}

          {view.stage === 'server_off' && (
            <div className="ps-note">
              <p className="ps-text">
                <strong>The server side of phone setup isn't switched on yet.</strong> The dialer's phone functions (small programs that run on your Supabase server and talk to Telnyx for the app) haven't been deployed, or the app can't reach the server right now.
              </p>
              <p className="ps-text muted">Whoever installed the app needs to deploy them. Then click Check again. Nothing on your Telnyx account has been changed.</p>
            </div>
          )}

          {view.stage === 'error' && status.state === 'error' && <div className="form-error">Couldn't check Telnyx: {plainPhoneError(status.message)}</div>}

          {view.stage === 'no_key' && <ConnectSteps rejected={false} />}
          {view.stage === 'bad_key' && <ConnectSteps rejected />}

          {view.rows.length > 0 && view.stage !== 'no_key' && view.stage !== 'bad_key' && (
            <ul className="ps-list" aria-label="Telnyx checks">
              {view.rows.map((r) => (
                <li key={r.key} className={`ps-row ${r.ok ? '' : 'ps-row-fail'}`} title={r.technical}>
                  <Mark ok={r.ok} />
                  <span className="ps-label">
                    {r.label}
                    {r.tip && <HelpTip text={r.tip} />}
                  </span>
                  <span className="ps-detail">
                    {r.detail}
                    {!r.ok && r.hint && <span className="ps-hint">{r.hint}</span>}
                  </span>
                </li>
              ))}
              {limit && (
                <li className={`ps-row ${limit.state === 'low' ? 'ps-row-fail' : ''}`}>
                  {limit.state === 'low' ? (
                    <span className="ps-mark ps-mark-warn">
                      <IconAlert size={13} />
                      Low
                    </span>
                  ) : limit.state === 'ok' ? (
                    <Mark ok />
                  ) : (
                    <span className="ps-mark ps-mark-info">
                      <IconInfo size={13} />
                      Info
                    </span>
                  )}
                  <span className="ps-label">
                    Simultaneous calls
                    <HelpTip
                      text={
                        data?.concurrentCallLimitSource === 'outbound_voice_profile'
                          ? 'How many calls can be open at the same time. This is the limit on the dialer\'s outbound profile; your Telnyx account may also have its own limit.'
                          : 'How many calls can be open at the same time on your Telnyx account. Telnyx does not show this to apps.'
                      }
                    />
                  </span>
                  <span className="ps-detail">
                    <span className="num ps-strong">{limit.value}</span>
                    <span className="ps-hint ps-hint-plain">{limit.text}</span>
                  </span>
                </li>
              )}
            </ul>
          )}

          {!ps.groups && otherNumbersText(data?.numbers ?? null) && <p className="ps-text muted">{otherNumbersText(data?.numbers ?? null)}</p>}
        </div>
      )}
    </section>
  );
}

function ConnectSteps({ rejected }: { rejected: boolean }) {
  const secrets = supabaseSecretsUrl(import.meta.env.VITE_SUPABASE_URL as string | undefined);
  return (
    <div className="ps-note">
      <p className="ps-text">
        <strong>{rejected ? "Telnyx didn't accept the API key saved in Supabase." : 'Connect your Telnyx account'}</strong>
        {rejected ? ' It may have been deleted or mistyped. Replace it:' : ' (one time, about 2 minutes):'}
      </p>
      <ol className="ps-steps">
        <li>
          In Telnyx, create {rejected ? 'a new' : 'an'} API key: Account settings &gt; API Keys &gt; Create API Key. Copy it. <ExtLink href={TELNYX_API_KEYS_URL}>Open Telnyx API keys</ExtLink>
        </li>
        <li>
          In Supabase, go to the Secrets page (in Supabase's menu: Edge Functions &gt; Secrets) and {rejected ? 'change the value of' : 'add'} the secret named <code className="ps-code">TELNYX_API_KEY</code>
          {rejected ? ' to the new key.' : ', with the key as its value.'}
          <HelpTip text="Secrets are private settings stored on your Supabase server, where the dialer's phone functions can read them. The key stays there; it is never put in this app or shown to callers." />{' '}
          <ExtLink href={secrets}>Open Supabase secrets</ExtLink>
        </li>
        <li>Come back here and click Check again, then Set up Telnyx.</li>
      </ol>
    </div>
  );
}

function SetupResultNote({ r }: { r: SetupResultView }) {
  return (
    <div className={`adm-callout adm-callout-${r.tone} ps-result`} role="status">
      {r.tone === 'good' ? <IconCheck /> : <IconAlert />}
      <div className="ps-result-body">
        <strong>{r.title}</strong>
        {r.groups.map((g) => (
          <div key={g.label} className="ps-result-line">
            <span className="ps-result-label">{g.label}:</span> {g.items.join(', ')}
          </div>
        ))}
        {r.warnings.map((w, i) => (
          <div key={i} className="ps-result-line">
            <span className="ps-result-label">Note:</span> {w}
          </div>
        ))}
      </div>
    </div>
  );
}

function SetupErrorNote({ message }: { message: string }) {
  const kind = classifyPhoneError(message);
  // The steps for these are shown right below.
  const extra = kind === 'missing_key' || kind === 'bad_key' ? ' Follow the steps below.' : '';
  return (
    <div className="form-error" role="alert">
      <IconAlert size={14} />
      <span>
        Set up didn't finish: {plainPhoneError(message)}
        {extra}
        {kind === 'other' ? ' Nothing else on your Telnyx account was changed. Try again in a minute.' : ''}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Numbers on the Telnyx account (after Sync)
// ---------------------------------------------------------------------------

export function TelnyxNumbers({ ps }: { ps: PhoneSetupState }) {
  const [confirm, setConfirm] = useState<AccountNumber | null>(null);
  const g = ps.groups;
  if (!g) return null;

  return (
    <section className="ps-numbers" aria-labelledby="ps-numbers-title">
      <h2 className="ps-title" id="ps-numbers-title">
        Numbers on your Telnyx account
        <HelpTip text="Found by the last Sync from Telnyx. Only numbers on the dialer are used for calls." />
      </h2>

      <div className="ps-group">
        <div className="ps-group-head">
          On the dialer <span className="ps-count num">{g.dialer.length}</span>
        </div>
        {g.dialer.length === 0 ? (
          <p className="ps-text muted">None yet.</p>
        ) : (
          <p className="ps-text">
            <span className="num">{g.dialer.map((n) => formatPhone(n.number)).join(', ')}</span> <span className="muted">(in the table below)</span>
          </p>
        )}
      </div>

      <div className="ps-group">
        <div className="ps-group-head">
          Not used yet <span className="ps-count num">{g.unused.length}</span>
          <HelpTip text="Numbers on your Telnyx account that no app uses. Use for dialer attaches one to the dialer so calls can go out from it and calls back to it ring your callers." />
        </div>
        {g.unused.length === 0 ? (
          <p className="ps-text muted">None.</p>
        ) : (
          <table className="table dense ps-table">
            <caption className="visually-hidden">Numbers not used yet</caption>
            <tbody>
              {g.unused.map((n) => (
                <tr key={n.providerId}>
                  <td className="num ps-num">{formatPhone(n.number)}</td>
                  <td className="ps-msg">{ps.assignErrors[n.providerId] && <span className="ps-refusal">{ps.assignErrors[n.providerId]}</span>}</td>
                  <td className="align-right">
                    <Button size="sm" loading={ps.assigning === n.providerId} disabled={ps.assigning !== null && ps.assigning !== n.providerId} onClick={() => setConfirm(n)}>
                      Use for dialer
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="ps-group">
        <div className="ps-group-head">
          In use by another app <span className="ps-count num">{g.elsewhere.length}</span>
          <HelpTip text="These numbers belong to other apps on your Telnyx account (for example Vapi). The dialer never uses, moves or changes them." />
        </div>
        {g.elsewhere.length === 0 ? (
          <p className="ps-text muted">None.</p>
        ) : (
          <table className="table dense ps-table">
            <caption className="visually-hidden">Numbers in use by other apps</caption>
            <tbody>
              {g.elsewhere.map((n) => (
                <tr key={n.providerId}>
                  <td className="num ps-num">{formatPhone(n.number)}</td>
                  <td className="ps-msg">
                    Used by <strong className="ps-app">{n.app}</strong>
                    <span className="muted">. Left alone.</span>
                  </td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="ps-text ps-buy">
        Need more numbers? Buy them on Telnyx, then click Sync from Telnyx. The app never buys numbers. <ExtLink href={TELNYX_BUY_NUMBERS_URL}>Open Telnyx number search</ExtLink>
      </p>

      <ConfirmDialog
        open={!!confirm}
        title="Use this number for the dialer?"
        message={
          confirm
            ? `${formatPhone(confirm.number)} will be attached to the dialer on Telnyx. Calls will go out from it, and calls back to it will ring your callers. It starts warming up today.`
            : ''
        }
        confirmLabel="Use for dialer"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const n = confirm;
          setConfirm(null);
          if (n) void ps.assign(n);
        }}
      />
    </section>
  );
}
