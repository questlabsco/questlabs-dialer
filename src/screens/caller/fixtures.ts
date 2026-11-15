/**
 * Fixture DialerStates for every phase, for visual review in dev:
 *   localStorage.setItem('questlabs.dialerFixture', 'connected')  then open the Dialer screen.
 * Remove the key (or use "Exit fixtures" in the dev bar) to go back to the real dialer.
 */
import type { CallRecord, Lead, MetricsTotals } from '../../types';
import { INITIAL_DIALER_STATE, type DialerSessionStats, type DialerState, type LineState } from '../../dialer/types';

export const FIXTURE_STORAGE_KEY = 'questlabs.dialerFixture';

export const FIXTURE_NAMES = [
  'idle',
  'idle_incoming',
  'starting',
  'dialing',
  'dialing_second_ring',
  'dialing_incoming',
  'queue_empty',
  'connected',
  'connected_muted',
  'connected_inbound',
  'connected_unknown',
  'wrap_up',
  'wrap_up_no_email',
  'wrap_up_pause_requested',
  'wrap_up_unknown',
  'paused',
  'error',
  'idle_manual_ended',
  'manual_ringing',
  'manual_ringing_lead',
  'manual_connected',
  'manual_connected_lead',
  'manual_wrap_up',
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

export interface DialerFixture {
  name: FixtureName;
  description: string;
  state: DialerState;
  statsToday: MetricsTotals;
  callbacksDue: number;
  /** Call history per lead id, newest first. */
  history: Record<string, CallRecord[]>;
}

export function isFixtureName(v: unknown): v is FixtureName {
  return typeof v === 'string' && (FIXTURE_NAMES as readonly string[]).includes(v);
}

const ME = 'fx-caller-me';
const TEAMMATE = 'fx-caller-2';

function iso(now: number, offsetSec: number): string {
  return new Date(now + offsetSec * 1000).toISOString();
}

function lead(now: number, id: string, patch: Partial<Lead>): Lead {
  return {
    id,
    listId: 'fx-list',
    businessName: 'Business',
    contactName: '',
    phones: ['+12145550100'],
    email: '',
    city: 'Dallas',
    state: 'TX',
    notes: '',
    status: 'new',
    assignedTo: null,
    attemptDays: 0,
    lastCalledAt: null,
    lastCalledBy: null,
    nextCallAt: null,
    callbackAt: null,
    callbackOwner: null,
    lockedBy: ME,
    lockedAt: iso(now, -60),
    createdAt: iso(now, -86_400 * 5),
    ...patch,
  };
}

function ringing(now: number, index: number, l: Lead, ring: 1 | 2, secondsAgo: number, phoneIdx = 0): LineState {
  return {
    index,
    status: 'ringing',
    lead: l,
    phone: l.phones[phoneIdx],
    fromNumber: index === 0 ? '+12145559001' : '+18175559002',
    ring,
    callId: `fx-call-${l.id}-${ring}`,
    startedAt: iso(now, -secondsAgo),
  };
}

function emptyLine(index: number): LineState {
  return { index, status: 'empty', lead: null, phone: '', fromNumber: '', ring: 1, callId: null, startedAt: null };
}

function call(now: number, id: string, leadId: string, patch: Partial<CallRecord>): CallRecord {
  return {
    id,
    leadId,
    listId: 'fx-list',
    callerId: ME,
    direction: 'outbound',
    fromNumber: '+12145559001',
    toNumber: '+12145550101',
    ring: 1,
    startedAt: iso(now, -86_400),
    answeredAt: null,
    endedAt: iso(now, -86_400 + 22),
    talkSeconds: 0,
    result: 'no_answer',
    disposition: null,
    notes: '',
    recordingUrl: null,
    ...patch,
  };
}

/** All fixtures, with times relative to `now` (ms). */
export function buildFixtures(now: number = Date.now()): Record<FixtureName, DialerFixture> {
  const acme = lead(now, 'fx-lead-acme', {
    businessName: 'Acme Roofing & Gutters',
    contactName: 'Dana Whitfield',
    phones: ['+12145550101', '+14695550177', '+19725550133'],
    email: 'dana@acmeroofing.example',
    city: 'Plano',
    notes: 'Owner-operated, 12 trucks. Asked to be called after 2pm.',
    status: 'no_answer',
    attemptDays: 1,
    lastCalledAt: iso(now, -86_400),
    lastCalledBy: ME,
  });
  const lonestar = lead(now, 'fx-lead-lonestar', {
    businessName: 'Lone Star HVAC Services',
    contactName: 'Marcus Reyes',
    phones: ['+18175550142'],
    email: '',
    city: 'Fort Worth',
    notes: '',
  });
  const bluebonnet = lead(now, 'fx-lead-bluebonnet', {
    businessName: 'Bluebonnet Dental Studio',
    contactName: '',
    phones: ['+19725550188', '+12145550199'],
    city: 'Irving',
  });
  const unknown: Lead = lead(now, 'unknown:+14695550123', {
    businessName: '',
    contactName: '',
    phones: ['+14695550123'],
    city: '',
    state: '',
    lockedBy: null,
    lockedAt: null,
    listId: '',
  });

  const session = (startedAgoSec: number, s: Partial<DialerSessionStats> = {}): DialerSessionStats => ({
    startedAt: iso(now, -startedAgoSec),
    dials: 46,
    pickups: 7,
    conversations: 4,
    bookings: 1,
    talkSeconds: 812,
    ...s,
  });

  const statsToday: MetricsTotals = {
    dials: 128,
    pickups: 19,
    pickupRate: 19 / 128,
    conversations: 11,
    bookings: 2,
    talkSeconds: 2470,
    droppedPickups: 1,
  };

  const history: Record<string, CallRecord[]> = {
    [acme.id]: [
      call(now, 'fx-h1', acme.id, { startedAt: iso(now, -86_400), result: 'no_answer', ring: 2 }),
      call(now, 'fx-h2', acme.id, { startedAt: iso(now, -86_400 - 30), result: 'no_answer' }),
      call(now, 'fx-h3', acme.id, {
        startedAt: iso(now, -86_400 * 3),
        callerId: TEAMMATE,
        result: 'answered',
        answeredAt: iso(now, -86_400 * 3 + 8),
        talkSeconds: 74,
        disposition: 'callback',
        notes: 'Busy on a job site. Said to try again later this week, prefers afternoons.',
      }),
    ],
    [lonestar.id]: [],
    [bluebonnet.id]: [call(now, 'fx-h4', bluebonnet.id, { startedAt: iso(now, -86_400 * 2), result: 'voicemail', toNumber: '+19725550188' })],
  };

  const base = INITIAL_DIALER_STATE;
  const twoRinging = [ringing(now, 0, acme, 1, 9), ringing(now, 1, lonestar, 1, 6)];

  const connectedState = (opts: { l: Lead; muted?: boolean; direction?: 'outbound' | 'inbound'; to?: string }): DialerState => ({
    ...base,
    phase: 'connected',
    lines: [
      { ...ringing(now, 0, opts.l, 1, 74, 0), status: 'answered', phone: opts.to ?? opts.l.phones[0] },
      emptyLine(1),
    ],
    activeCall: {
      lead: opts.l,
      callId: 'fx-active',
      callRecordId: `fx-rec-${opts.l.id}`,
      fromNumber: opts.direction === 'inbound' ? opts.l.phones[0] : '+12145559001',
      toNumber: opts.direction === 'inbound' ? '+12145559001' : opts.to ?? opts.l.phones[0],
      answeredAt: iso(now, -65),
      muted: !!opts.muted,
      direction: opts.direction ?? 'outbound',
    },
    session: session(2_700),
  });

  const wrapState = (l: Lead, patch: Partial<DialerState> = {}): DialerState => ({
    ...base,
    phase: 'wrap_up',
    lines: [emptyLine(0), emptyLine(1)],
    wrapUp: { lead: l, callRecordId: `fx-rec-${l.id}`, talkSeconds: 143 },
    session: session(2_900),
    ...patch,
  });

  // Manual calls (callNumber): one line, rung once.
  const manualTo = '+14695550123';
  const manualLine = (l: Lead, phone: string, status: 'ringing' | 'answered', secondsAgo: number): LineState => ({
    index: 0,
    status,
    lead: l,
    phone,
    fromNumber: '+14695559003',
    ring: 1,
    callId: `fx-manual-${l.id}`,
    startedAt: iso(now, -secondsAgo),
    manual: true,
  });
  const manualSession = session(30, { dials: 1, pickups: 0, conversations: 0, bookings: 0, talkSeconds: 0 });
  const manualConnected = (l: Lead, phone: string): DialerState => ({
    ...base,
    phase: 'connected',
    lines: [manualLine(l, phone, 'answered', 50)],
    activeCall: {
      lead: l,
      callId: `fx-manual-${l.id}`,
      callRecordId: `fx-rec-manual-${l.id}`,
      fromNumber: '+14695559003',
      toNumber: phone,
      answeredAt: iso(now, -42),
      muted: false,
      direction: 'outbound',
      manual: true,
    },
    session: { ...manualSession, pickups: 1 },
  });

  const f = (name: FixtureName, description: string, state: DialerState, extra: Partial<DialerFixture> = {}): DialerFixture => ({
    name,
    description,
    state,
    statsToday,
    callbacksDue: 3,
    history,
    ...extra,
  });

  return {
    idle: f('idle', 'Not started: Start button, today, mic check, script', base),
    idle_incoming: f('idle_incoming', 'Idle with an incoming call from an unknown number', {
      ...base,
      incoming: { callId: 'fx-in-1', from: '+14695550123', lead: null },
    }),
    starting: f('starting', 'Connecting audio / claiming leads', {
      ...base,
      phase: 'starting',
      lines: [emptyLine(0), emptyLine(1)],
      session: session(1, { dials: 0, pickups: 0, conversations: 0, bookings: 0, talkSeconds: 0 }),
    }),
    dialing: f('dialing', 'Two lines ringing', { ...base, phase: 'dialing', lines: twoRinging, session: session(1_500) }),
    dialing_second_ring: f('dialing_second_ring', 'One line on its second ring, one line finding a lead', {
      ...base,
      phase: 'dialing',
      lines: [ringing(now, 0, bluebonnet, 2, 4, 1), emptyLine(1)],
      session: session(1_800),
    }),
    dialing_incoming: f('dialing_incoming', 'Dialing while a known lead calls back', {
      ...base,
      phase: 'dialing',
      lines: twoRinging,
      incoming: { callId: 'fx-in-2', from: '+18175550142', lead: lonestar },
      session: session(1_600),
    }),
    queue_empty: f('queue_empty', 'Nothing left to dial', {
      ...base,
      phase: 'dialing',
      lines: [emptyLine(0), emptyLine(1)],
      queueEmpty: true,
      session: session(3_600),
    }),
    connected: f('connected', 'Talking to a lead (outbound, second phone)', connectedState({ l: acme, to: acme.phones[1] })),
    connected_muted: f('connected_muted', 'Connected and muted, lead with no email', connectedState({ l: lonestar, muted: true })),
    connected_inbound: f('connected_inbound', 'Inbound call from a known lead', connectedState({ l: acme, direction: 'inbound' })),
    connected_unknown: f('connected_unknown', 'Inbound call from an unknown number', connectedState({ l: unknown, direction: 'inbound' })),
    wrap_up: f('wrap_up', 'Pick an outcome', wrapState(acme)),
    wrap_up_no_email: f('wrap_up_no_email', 'Wrap-up for a lead without an email (try Booked)', wrapState(lonestar)),
    wrap_up_pause_requested: f('wrap_up_pause_requested', 'Wrap-up with "Pause after this call" on', wrapState(bluebonnet, { pauseRequested: true })),
    wrap_up_unknown: f('wrap_up_unknown', 'Wrap-up after an unknown inbound caller', wrapState(unknown)),
    paused: f('paused', 'Paused between calls', {
      ...base,
      phase: 'paused',
      lines: [emptyLine(0), emptyLine(1)],
      session: session(3_100),
    }),
    error: f('error', 'Fatal problem', {
      ...base,
      phase: 'error',
      error: 'Could not connect to the phone service. Check your internet connection and try again.',
      session: session(200, { dials: 3, pickups: 0, conversations: 0, bookings: 0, talkSeconds: 0 }),
    }),
    idle_manual_ended: f('idle_manual_ended', 'Idle after a manual call that was not answered', {
      ...base,
      manualEnded: { phone: manualTo, result: 'no_answer', endedAt: iso(now, -5) },
    }),
    manual_ringing: f('manual_ringing', 'Manual call to a number that is not a lead, ringing', {
      ...base,
      phase: 'dialing',
      lines: [manualLine(unknown, manualTo, 'ringing', 7)],
      session: manualSession,
    }),
    manual_ringing_lead: f('manual_ringing_lead', 'Manual call to a known lead, ringing', {
      ...base,
      phase: 'dialing',
      lines: [manualLine(lonestar, lonestar.phones[0], 'ringing', 4)],
      session: manualSession,
    }),
    manual_connected: f('manual_connected', 'Manual call answered (number not in leads)', manualConnected(unknown, manualTo)),
    manual_connected_lead: f('manual_connected_lead', 'Manual call answered by a known lead', manualConnected(acme, acme.phones[0])),
    manual_wrap_up: f('manual_wrap_up', 'Wrap-up after a manual call to a known lead', wrapState(acme, { wrapUp: { lead: acme, callRecordId: `fx-rec-manual-${acme.id}`, talkSeconds: 96, manual: true }, lines: [emptyLine(0)] })),
  };
}
