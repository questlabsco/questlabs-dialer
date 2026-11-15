import { describe, expect, it } from 'vitest';
import {
  callFromRow,
  callListRowFromRow,
  callPatchToRow,
  importRowToJson,
  isoOrNull,
  leadFromRow,
  leadListFromRow,
  leadPatchToRow,
  leadSortColumn,
  metricsFromJson,
  myScriptFromJson,
  newCallToRow,
  normalizePhoneList,
  numberFromRow,
  presenceFromRow,
  profileFromRow,
  settingsFromRow,
  settingsToRow,
  totalsFromJson,
} from './supabaseMappers';
import { DEFAULT_SETTINGS } from '../types';

describe('isoOrNull', () => {
  it('normalises Postgres timestamp text to ISO', () => {
    expect(isoOrNull('2026-11-15T14:00:00.123456+00:00')).toBe('2026-11-15T14:00:00.123Z');
    expect(isoOrNull('2026-11-15 14:00:00+00')).toBe('2026-11-15T14:00:00.000Z');
    expect(isoOrNull('2026-11-15 08:00:00.5-06')).toBe('2026-11-15T14:00:00.500Z');
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull('')).toBeNull();
    expect(isoOrNull('not a date')).toBeNull();
  });
});

describe('row -> type', () => {
  it('maps a profile', () => {
    expect(profileFromRow({ id: 'u1', email: 'a@b.co', full_name: 'Ann', role: 'admin', active: false, created_at: '2026-01-01T00:00:00+00:00' })).toEqual({
      id: 'u1',
      email: 'a@b.co',
      fullName: 'Ann',
      role: 'admin',
      active: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(profileFromRow({ id: 'u2', role: 'weird' }).role).toBe('caller');
  });

  it('maps a lead (incl. Postgres array text and nulls)', () => {
    const l = leadFromRow({
      id: 'l1',
      list_id: 'L',
      business_name: 'Acme',
      contact_name: null,
      phones: ['+12145550100', '+12145550101'],
      primary_phone: '+12145550100',
      email: 'x@y.z',
      city: 'Dallas',
      state: 'TX',
      notes: '',
      status: 'callback',
      assigned_to: null,
      attempt_days: 2,
      last_called_at: '2026-11-15T14:00:00+00:00',
      last_called_by: 'u1',
      next_call_at: null,
      callback_at: '2026-11-16T15:00:00+00:00',
      callback_owner: 'u1',
      locked_by: null,
      locked_at: null,
      created_at: '2026-11-01T00:00:00+00:00',
    });
    expect(l).toEqual({
      id: 'l1',
      listId: 'L',
      businessName: 'Acme',
      contactName: '',
      phones: ['+12145550100', '+12145550101'],
      email: 'x@y.z',
      city: 'Dallas',
      state: 'TX',
      notes: '',
      status: 'callback',
      assignedTo: null,
      attemptDays: 2,
      lastCalledAt: '2026-11-15T14:00:00.000Z',
      lastCalledBy: 'u1',
      nextCallAt: null,
      callbackAt: '2026-11-16T15:00:00.000Z',
      callbackOwner: 'u1',
      lockedBy: null,
      lockedAt: null,
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    expect(leadFromRow({ phones: '{+12145550100,+12145550101}' }).phones).toEqual(['+12145550100', '+12145550101']);
    expect(leadFromRow({ phones: '{}' }).phones).toEqual([]);
  });

  it('maps lists, calls, call list rows, numbers and presence', () => {
    expect(leadListFromRow({ id: 'L', name: 'N', created_at: '2026-11-01T00:00:00Z', lead_count: '5', remaining_count: 3 })).toEqual({
      id: 'L',
      name: 'N',
      createdAt: '2026-11-01T00:00:00.000Z',
      leadCount: 5,
      remainingCount: 3,
    });
    const callRow = {
      id: 'c1',
      lead_id: 'l1',
      list_id: 'L',
      caller_id: 'u1',
      direction: 'outbound',
      from_number: '+12145550001',
      to_number: '+12145550100',
      ring: 2,
      started_at: '2026-11-15T14:00:00+00:00',
      answered_at: null,
      ended_at: '2026-11-15T14:00:22+00:00',
      talk_seconds: 0,
      result: 'no_answer',
      disposition: null,
      notes: '',
      recording_url: null,
      provider_call_id: 'tx-1',
    };
    const c = callFromRow(callRow);
    expect(c.ring).toBe(2);
    expect(c.result).toBe('no_answer');
    expect(c.disposition).toBeNull();
    expect(c.providerCallId).toBe('tx-1');
    expect(c.endedAt).toBe('2026-11-15T14:00:22.000Z');
    const lr = callListRowFromRow({ ...callRow, business_name: 'Acme', contact_name: null, caller_name: 'Ann' });
    expect([lr.businessName, lr.contactName, lr.callerName]).toEqual(['Acme', null, 'Ann']);

    const n = numberFromRow({
      id: 'n1',
      number: '+12145550001',
      label: 'DFW',
      active: true,
      daily_cap: 100,
      added_at: '2026-11-01T00:00:00Z',
      provider_id: null,
      effective_cap_today: 61,
      calls_today: 4,
      calls_7d: 40,
      pickup_rate_7d: 0.125,
      flagged: true,
    });
    expect(n).toEqual({
      id: 'n1',
      number: '+12145550001',
      label: 'DFW',
      active: true,
      dailyCap: 100,
      addedAt: '2026-11-01T00:00:00.000Z',
      effectiveCapToday: 61,
      callsToday: 4,
      pickupRate7d: 0.125,
      calls7d: 40,
      flagged: true,
      providerId: null,
    });
    expect(presenceFromRow({ caller_id: 'u1', full_name: 'Ann', status: 'bogus', since: '2026-11-15T14:00:00Z', detail: null }).status).toBe('offline');
  });
});

describe('settings', () => {
  it('round-trips and falls back to defaults', () => {
    const row = settingsToRow(DEFAULT_SETTINGS);
    expect(row).toMatchObject({ lines_per_caller: 2, ring_seconds: 22, ramp_start_cap: 25, record_calls: true, calendly_url: DEFAULT_SETTINGS.calendlyUrl });
    expect(settingsFromRow({ ...row, time_zone: 'America/Chicago' })).toEqual(DEFAULT_SETTINGS);
    expect(settingsFromRow({})).toEqual(DEFAULT_SETTINGS);
    expect(settingsToRow({ ringSeconds: 30 })).toEqual({ ring_seconds: 30 });
    expect(settingsToRow({ bogus: 1 } as never)).toEqual({});
  });
});

describe('my script', () => {
  it('maps get_my_script() JSON', () => {
    expect(myScriptFromJson({ script: 'Mine', isPersonal: true, teamScript: 'Team' })).toEqual({ script: 'Mine', isPersonal: true, teamScript: 'Team' });
    expect(myScriptFromJson({ script: 'Team', isPersonal: false, teamScript: 'Team' })).toEqual({ script: 'Team', isPersonal: false, teamScript: 'Team' });
    expect(myScriptFromJson({ script: 'Mine', is_personal: true, team_script: 'Team' })).toEqual({ script: 'Mine', isPersonal: true, teamScript: 'Team' });
  });
  it('falls back to the team script for blank or malformed input', () => {
    expect(myScriptFromJson({ script: '  ', isPersonal: true, teamScript: 'Team' })).toEqual({ script: 'Team', isPersonal: false, teamScript: 'Team' });
    expect(myScriptFromJson(null)).toEqual({ script: '', isPersonal: false, teamScript: '' });
    expect(myScriptFromJson([1, 2])).toEqual({ script: '', isPersonal: false, teamScript: '' });
  });
});

describe('writes', () => {
  it('maps a lead patch to snake_case and drops unknown keys', () => {
    expect(
      leadPatchToRow({ contactName: 'Zed', assignedTo: null, callbackAt: '2026-11-16T15:00:00.000Z', status: 'callback', ...({ lockedBy: 'x' } as object) }),
    ).toEqual({ contact_name: 'Zed', assigned_to: null, callback_at: '2026-11-16T15:00:00.000Z', status: 'callback' });
  });

  it('normalises phone lists', () => {
    expect(normalizePhoneList(['(214) 555-0123', '214.555.0123', '972-555-0199'])).toEqual({ phones: ['+12145550123', '+19725550199'] });
    expect(normalizePhoneList(['214', '+12145550123'])).toEqual({ invalid: '214' });
  });

  it('prepares import rows', () => {
    expect(importRowToJson({ businessName: '  Acme ', phones: ['bad', '(214) 555-0123', '+1 214 555 0123', '9725550199', '8175550100', '4695550100'] })).toEqual({
      businessName: 'Acme',
      contactName: '',
      phones: ['+12145550123', '+19725550199', '+18175550100'],
      email: '',
      city: '',
      state: '',
      notes: '',
    });
  });

  it('builds a call row with caller default and normalised numbers', () => {
    const row = newCallToRow({ leadId: 'l1', direction: 'outbound', fromNumber: '(214) 555-0001', toNumber: '+12145550100', ring: 1, startedAt: '2026-11-15T14:00:00Z' }, 'me');
    expect(row).toMatchObject({ caller_id: 'me', from_number: '+12145550001', to_number: '+12145550100', started_at: '2026-11-15T14:00:00.000Z', talk_seconds: 0, result: null, notes: '' });
    expect(newCallToRow({ leadId: null, direction: 'inbound', fromNumber: 'x', toNumber: 'y', ring: 1, callerId: null }, 'me').caller_id).toBeNull();
    expect(callPatchToRow({ talkSeconds: 12.6, answeredAt: '2026-11-15T14:00:00Z', result: 'answered' })).toEqual({
      talk_seconds: 13,
      answered_at: '2026-11-15T14:00:00.000Z',
      result: 'answered',
    });
  });

  it('whitelists sort columns', () => {
    expect(leadSortColumn('lastCalledAt')).toBe('last_called_at');
    expect(leadSortColumn('phones; drop')).toBe('created_at');
    expect(leadSortColumn(undefined)).toBe('created_at');
  });
});

describe('metrics', () => {
  it('maps the SQL JSON and fills outcomes in DISPOSITIONS order', () => {
    const t = { dials: 4, pickups: 1, pickupRate: 0.25, conversations: 1, bookings: 1, talkSeconds: 60, droppedPickups: 0 };
    const m = metricsFromJson(
      {
        totals: t,
        previousTotals: { dials: 0, pickups: 0, pickupRate: 0, conversations: 0, bookings: 0, talkSeconds: 0, droppedPickups: 0 },
        byCaller: [{ ...t, callerId: 'u1', label: 'Ann' }],
        byDay: [{ ...t, date: '2026-11-15', label: 'Sun, Nov 15' }],
        byNumber: [{ ...t, number: '+12145550001', numberId: null, label: '+12145550001 (removed)' }],
        byList: [{ ...t, listId: 'L', label: 'Deleted list' }],
        outcomes: [{ disposition: 'booked', label: 'Booked', count: 1 }],
      },
      { from: '2026-11-15T06:00:00Z', to: '2026-11-16T06:00:00Z' },
    );
    expect(m.range).toEqual({ from: '2026-11-15T06:00:00.000Z', to: '2026-11-16T06:00:00.000Z' });
    expect(m.totals).toEqual(t);
    expect(m.byCaller[0]).toEqual({ ...t, callerId: 'u1', label: 'Ann' });
    expect(m.byNumber[0].numberId).toBeNull();
    expect(m.outcomes.map((o) => o.disposition)).toEqual(['booked', 'callback', 'not_interested', 'wrong_number', 'do_not_call', 'voicemail', 'hung_up']);
    expect(m.outcomes[0].count).toBe(1);
    expect(m.outcomes[1].count).toBe(0);
  });

  it('defaults totals safely', () => {
    expect(totalsFromJson(null)).toEqual({ dials: 0, pickups: 0, pickupRate: 0, conversations: 0, bookings: 0, talkSeconds: 0, droppedPickups: 0 });
    expect(totalsFromJson({ dials: '10', pickups: '2' }).pickupRate).toBeCloseTo(0.2);
  });
});
