import { describe, expect, it } from 'vitest';
import type { DialerPhase, DialerState } from '../../dialer/types';
import { FIXTURE_NAMES, buildFixtures, isFixtureName } from './fixtures';
import { isUnknownLead } from './dialerLogic';

const NOW = new Date(2026, 10, 11, 14, 0, 0).getTime();
const PHASES: DialerPhase[] = ['idle', 'starting', 'dialing', 'connected', 'wrap_up', 'paused', 'error'];
const isIso = (s: string) => !Number.isNaN(new Date(s).getTime()) && new Date(s).toISOString() === s;

/** Structural invariants of a DialerState as described in src/dialer/types.ts. */
function problems(s: DialerState): string[] {
  const out: string[] = [];
  if (!PHASES.includes(s.phase)) out.push(`bad phase ${s.phase}`);
  if (s.phase === 'idle' && s.lines.length !== 0) out.push('idle must have no lines');
  if (s.phase !== 'idle' && s.phase !== 'error' && s.lines.length === 0) out.push('running phase needs lines');
  s.lines.forEach((l, i) => {
    if (l.index !== i) out.push(`line ${i} index ${l.index}`);
    if (l.ring !== 1 && l.ring !== 2) out.push(`line ${i} ring`);
    if (l.status === 'empty') {
      if (l.lead || l.phone || l.fromNumber || l.callId || l.startedAt) out.push(`empty line ${i} has data`);
    } else {
      if (!l.lead || !l.callId || !l.startedAt || !isIso(l.startedAt)) out.push(`busy line ${i} missing data`);
      if (l.lead && !l.lead.phones.includes(l.phone)) out.push(`line ${i} phone not on lead`);
      if (!/^\+\d{8,15}$/.test(l.fromNumber)) out.push(`line ${i} fromNumber`);
    }
  });
  if ((s.phase === 'connected') !== (s.activeCall !== null)) out.push('activeCall iff connected');
  if ((s.phase === 'wrap_up') !== (s.wrapUp !== null)) out.push('wrapUp iff wrap_up');
  if ((s.phase === 'error') !== (s.error !== null)) out.push('error iff phase error');
  if (s.activeCall && !isIso(s.activeCall.answeredAt)) out.push('answeredAt');
  if (s.activeCall && !['inbound', 'outbound'].includes(s.activeCall.direction)) out.push('direction');
  if (s.incoming && !/^\+\d{8,15}$/.test(s.incoming.from)) out.push('incoming.from');
  if (s.session.startedAt !== null && !isIso(s.session.startedAt)) out.push('session.startedAt');
  if (s.phase !== 'idle' && s.session.startedAt === null) out.push('running without session start');
  for (const k of ['dials', 'pickups', 'conversations', 'bookings', 'talkSeconds'] as const) {
    if (!Number.isFinite(s.session[k]) || s.session[k] < 0) out.push(`session.${k}`);
  }
  if (s.pauseRequested && s.phase !== 'connected' && s.phase !== 'wrap_up') out.push('pauseRequested outside call');
  return out;
}

describe('dialer fixtures', () => {
  const fixtures = buildFixtures(NOW);

  it('has one fixture per name, keyed by name', () => {
    expect(Object.keys(fixtures).sort()).toEqual([...FIXTURE_NAMES].sort());
    for (const n of FIXTURE_NAMES) expect(fixtures[n].name).toBe(n);
    expect(isFixtureName('connected')).toBe(true);
    expect(isFixtureName('nope')).toBe(false);
    expect(isFixtureName(null)).toBe(false);
  });

  it('covers every phase', () => {
    const covered = new Set(Object.values(fixtures).map((f) => f.state.phase));
    for (const p of PHASES) expect(covered.has(p)).toBe(true);
  });

  it('covers the special cases', () => {
    expect(Object.values(fixtures).some((f) => f.state.incoming)).toBe(true);
    expect(Object.values(fixtures).some((f) => f.state.queueEmpty)).toBe(true);
    expect(Object.values(fixtures).some((f) => f.state.lines.some((l) => l.ring === 2))).toBe(true);
    expect(Object.values(fixtures).some((f) => f.state.lines.some((l) => l.status === 'empty') && f.state.lines.some((l) => l.status === 'ringing'))).toBe(true);
    expect(fixtures.connected_inbound.state.activeCall?.direction).toBe('inbound');
    expect(isUnknownLead(fixtures.connected_unknown.state.activeCall?.lead)).toBe(true);
    expect(fixtures.wrap_up_no_email.state.wrapUp?.lead.email).toBe('');
    expect(fixtures.wrap_up_pause_requested.state.pauseRequested).toBe(true);
    expect(fixtures.manual_ringing.state.lines).toEqual([expect.objectContaining({ manual: true, status: 'ringing' })]);
    expect(isUnknownLead(fixtures.manual_ringing.state.lines[0].lead)).toBe(true);
    expect(fixtures.manual_connected.state.activeCall?.manual).toBe(true);
    expect(isUnknownLead(fixtures.manual_connected.state.activeCall?.lead)).toBe(true);
    expect(isUnknownLead(fixtures.manual_connected_lead.state.activeCall?.lead)).toBe(false);
    expect(fixtures.manual_wrap_up.state.wrapUp?.manual).toBe(true);
    expect(fixtures.idle_manual_ended.state.manualEnded?.result).toBe('no_answer');
  });

  for (const name of FIXTURE_NAMES) {
    it(`${name} is a valid DialerState`, () => {
      expect(problems(fixtures[name].state)).toEqual([]);
    });
  }

  it('is JSON-serialisable (plain data only)', () => {
    const f = fixtures.connected;
    expect(JSON.parse(JSON.stringify(f.state))).toEqual(f.state);
  });
});
