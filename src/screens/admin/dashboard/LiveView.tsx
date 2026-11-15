/** Live view: one row per caller, always "now", independent of the dashboard's date range. */
import { useEffect, useState, type ReactNode } from 'react';
import type { Presence, PresenceStatus } from '../../../types';
import { PRESENCE_LABELS } from '../../../types';
import { api, errorMessage } from '../../../api';
import { formatTime } from '../../../lib/format';
import {
  Badge,
  Button,
  Card,
  IconClock,
  IconDialer,
  IconNote,
  IconPause,
  IconPhone,
  IconPhoneOff,
  Spinner,
  type Tone,
} from '../../../components/ui';
import { formatElapsed, presenceSummary, sortPresence } from './chartMath';

const STATUS_STYLE: Record<PresenceStatus, { tone: Tone; icon: ReactNode }> = {
  on_call: { tone: 'good', icon: <IconPhone size={12} /> },
  wrap_up: { tone: 'warning', icon: <IconNote size={12} /> },
  dialing: { tone: 'accent', icon: <IconDialer size={12} /> },
  paused: { tone: 'neutral', icon: <IconPause size={12} /> },
  idle: { tone: 'neutral', icon: <IconClock size={12} /> },
  offline: { tone: 'neutral', icon: <IconPhoneOff size={12} /> },
};

export function PresenceBadge({ status }: { status: PresenceStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <Badge tone={s.tone} className={`dz-presence dz-presence-${status}`}>
      {PRESENCE_LABELS[status]}
    </Badge>
  );
}

export function LiveView() {
  const [list, setList] = useState<Presence[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    api
      .listPresence()
      .then((l) => {
        if (alive) {
          setList(l);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(errorMessage(e));
      });
    const unsubscribe = api.subscribePresence((l) => {
      if (!alive) return;
      setList(l);
      setError(null);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [attempt]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const rows = list ? sortPresence(list) : [];

  return (
    <Card className="dz-card dz-live" title="Live now" actions={list ? <span className="dz-sub">{presenceSummary(rows)}</span> : undefined} padded={false}>
      {error && !list ? (
        <div className="dz-live-msg">
          <p>Could not load the live view: {error}</p>
          <Button size="sm" onClick={() => setAttempt((a) => a + 1)}>
            Retry
          </Button>
        </div>
      ) : !list ? (
        <div className="dz-live-msg">
          <Spinner label="Loading live view" />
        </div>
      ) : (
        <>
          <div className="visually-hidden" aria-live="polite">
            {presenceSummary(rows)}
          </div>
          {error && (
            <div className="dz-live-warn" role="alert">
              Live updates interrupted: {error}{' '}
              <Button size="sm" variant="ghost" onClick={() => setAttempt((a) => a + 1)}>
                Retry
              </Button>
            </div>
          )}
          {rows.length === 0 ? (
            <p className="dz-live-msg">No active callers. Add callers on the Team screen.</p>
          ) : (
            <ul className="dz-live-list">
              {rows.map((p) => {
                const sinceMs = Date.parse(p.since);
                const elapsed = Number.isFinite(sinceMs) ? formatElapsed(now - sinceMs) : '';
                return (
                  <li key={p.callerId} className={`dz-live-row dz-live-${p.status}`} title={p.detail || undefined}>
                    <span className="dz-live-name">{p.fullName}</span>
                    {p.detail && <span className="dz-live-detail">{p.detail}</span>}
                    <PresenceBadge status={p.status} />
                    <span className="dz-live-time num" title={Number.isFinite(sinceMs) ? `Since ${formatTime(sinceMs)}` : undefined}>
                      {elapsed}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
