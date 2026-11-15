import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { useDialer } from '../../dialer/useDialer';
import type { DialerControls } from '../../dialer/types';
import { Button, Checkbox, Select } from '../../components/ui';
import { DEFAULT_SETTINGS, type Lead, type MetricsTotals, type Settings } from '../../types';
import { DialerView, type DialerDataSource } from './DialerView';
import { countDueCallbacks } from './dialerLogic';
import { FIXTURE_NAMES, FIXTURE_STORAGE_KEY, buildFixtures, isFixtureName, type FixtureName } from './fixtures';

function useSettings(): Settings | null {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .getSettings()
      .then((s) => {
        if (alive) setSettings(s);
      })
      .catch(() => {
        if (alive) setSettings({ ...DEFAULT_SETTINGS });
      });
    return () => {
      alive = false;
    };
  }, []);
  return settings;
}

/** The real dialer, wired to the shared engine. */
function LiveDialer() {
  const { state, controls } = useDialer();
  const { profile } = useAuth();
  const settings = useSettings();
  const [stats, setStats] = useState<MetricsTotals | null>(null);
  const [callbacksDue, setCallbacksDue] = useState<number | null>(null);
  const idle = state.phase === 'idle';

  // Refresh today's numbers whenever we are back on the idle screen.
  useEffect(() => {
    if (!idle) return;
    let alive = true;
    api
      .getMyStatsToday()
      .then((s) => alive && setStats(s))
      .catch(() => undefined);
    api
      .getMyCallbacks()
      .then((list) => alive && setCallbacksDue(countDueCallbacks(list, Date.now())))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [idle]);

  const data = useMemo<DialerDataSource>(
    () => ({
      getLeadHistory: (id) => api.getLeadHistory(id),
      updateLead: (id, patch) => api.updateLead(id, patch),
    }),
    [],
  );

  return (
    <DialerView
      state={state}
      controls={controls}
      settings={settings}
      callerId={profile?.id ?? ''}
      callerName={profile?.fullName ?? ''}
      statsToday={stats}
      callbacksDue={callbacksDue}
      data={data}
    />
  );
}

// ---------------------------------------------------------------------------
// Dev-only fixture mode: localStorage['questlabs.dialerFixture'] = a fixture name
// ---------------------------------------------------------------------------

function readFixtureName(): FixtureName | null {
  if (!import.meta.env.DEV) return null;
  try {
    const v = window.localStorage.getItem(FIXTURE_STORAGE_KEY);
    return isFixtureName(v) ? v : null;
  } catch {
    return null;
  }
}

const noop = async () => undefined;
const NOOP_CONTROLS: DialerControls = {
  start: noop,
  pause: noop,
  resume: noop,
  stop: noop,
  hangUp: noop,
  toggleMute: noop,
  sendDigits: noop,
  submitDisposition: noop,
  answerIncoming: noop,
  declineIncoming: noop,
  callNumber: noop,
};

const DEMO_CALENDLY = 'https://calendly.com/questlabs-demo/intro-call';

function FixtureDialer({ initial }: { initial: FixtureName }) {
  const { profile } = useAuth();
  const loaded = useSettings();
  const [name, setName] = useState<FixtureName>(initial);
  const [calendlySet, setCalendlySet] = useState(false);
  const fixture = useMemo(() => buildFixtures(Date.now())[name], [name]);

  const settings = useMemo<Settings | null>(() => {
    if (!loaded) return null;
    return { ...loaded, calendlyUrl: calendlySet ? DEMO_CALENDLY : loaded.calendlyUrl };
  }, [loaded, calendlySet]);

  const data = useMemo<DialerDataSource>(() => {
    const leads = new Map<string, Lead>();
    const s = fixture.state;
    for (const l of s.lines) if (l.lead) leads.set(l.lead.id, l.lead);
    if (s.activeCall) leads.set(s.activeCall.lead.id, s.activeCall.lead);
    if (s.wrapUp) leads.set(s.wrapUp.lead.id, s.wrapUp.lead);
    return {
      getLeadHistory: (id) => new Promise((resolve) => setTimeout(() => resolve(fixture.history[id] ?? []), 300)),
      updateLead: async (id, patch) => {
        const l = leads.get(id);
        if (!l) throw new Error('Lead not found in fixture.');
        const next = { ...l, ...patch };
        leads.set(id, next);
        return next;
      },
    };
  }, [fixture]);

  const switchTo = (next: string) => {
    if (!isFixtureName(next)) return;
    try {
      window.localStorage.setItem(FIXTURE_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    setName(next);
  };

  const exit = () => {
    try {
      window.localStorage.removeItem(FIXTURE_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  const devBar = (
    <div className="dl-devbar" role="region" aria-label="Dialer fixtures (development only)">
      <strong>Fixture</strong>
      <Select
        aria-label="Fixture"
        value={name}
        onChange={(e) => switchTo(e.target.value)}
        options={FIXTURE_NAMES.map((n) => ({ value: n, label: n }))}
        fieldClassName="dl-devbar-select"
      />
      <span className="muted dl-devbar-desc">{fixture.description}</span>
      <Checkbox label="Calendly link set" checked={calendlySet} onChange={setCalendlySet} />
      <Button size="sm" variant="ghost" onClick={exit}>
        Exit fixtures
      </Button>
    </div>
  );

  return (
    <DialerView
      key={name}
      state={fixture.state}
      controls={NOOP_CONTROLS}
      settings={settings}
      callerId="fx-caller-me"
      callerName={profile?.fullName ?? 'Sam Caller'}
      statsToday={fixture.statsToday}
      callbacksDue={fixture.callbacksDue}
      data={data}
      topSlot={devBar}
    />
  );
}

/** Dialer screen: the power dialer for callers. */
export default function DialerScreen() {
  const [fixture] = useState<FixtureName | null>(readFixtureName);
  if (fixture) return <FixtureDialer initial={fixture} />;
  return <LiveDialer />;
}
