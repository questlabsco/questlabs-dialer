import { describe, expect, it } from 'vitest';
import { DemoApi } from './demoApi';
import { ApiError } from './Api';
import { addDays, startOfDay, startOfNextDay } from '../lib/format';
import type { NewLead } from '../types';

// Wednesday 2026-11-11 14:00 local.
const NOW = new Date(2026, 10, 11, 14, 0, 0).getTime();

function makeApi(opts: { empty?: boolean; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: NOW };
  const api = new DemoApi({ storage: null, now: () => clock.t, simulatePresence: false, empty: opts.empty ?? true });
  return { api, clock };
}

function rows(n: number, prefix: string, startExt = 100): NewLead[] {
  return Array.from({ length: n }, (_, i) => ({
    businessName: `${prefix} ${i}`,
    contactName: `Owner ${i}`,
    phones: [`(214) 555-${String(startExt + i).padStart(4, '0')}`],
    email: `owner${i}@example.com`,
  }));
}

describe('demo api: auth & permissions', () => {
  it('rejects admin-only methods for callers with permission_denied', async () => {
    const { api } = makeApi();
    await api.signInDemo('caller');
    await expect(api.listUsers()).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(api.queryLeads({ page: 1, pageSize: 10 })).rejects.toBeInstanceOf(ApiError);
    await expect(api.exportLeads({})).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('requires a session', async () => {
    const { api } = makeApi();
    await expect(api.getSettings()).rejects.toMatchObject({ code: 'not_authenticated' });
  });
});

describe('my script', () => {
  function memoryStorage() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  }

  it('falls back to the team script, saves a personal copy, and resets', async () => {
    const { api } = makeApi();
    await api.signInDemo('admin');
    await api.saveSettings({ script: 'Team {callerName}' });
    await api.signInDemo('caller');
    expect(await api.getMyScript()).toEqual({ script: 'Team {callerName}', isPersonal: false, teamScript: 'Team {callerName}' });
    await api.saveMyScript('Mine {contactName}');
    expect(await api.getMyScript()).toEqual({ script: 'Mine {contactName}', isPersonal: true, teamScript: 'Team {callerName}' });
    await api.saveMyScript('   ');
    expect((await api.getMyScript()).isPersonal).toBe(false);
    await api.saveMyScript('Again');
    await api.saveMyScript(null);
    expect(await api.getMyScript()).toMatchObject({ script: 'Team {callerName}', isPersonal: false });
  });

  it('keeps each user’s copy separate and does not touch the team script', async () => {
    const { api } = makeApi();
    const callers = api.debugState().users.filter((u) => u.role === 'caller' && u.active);
    expect(callers.length).toBeGreaterThanOrEqual(2);
    await api.signIn(callers[0].email, 'x');
    await api.saveMyScript('First caller');
    await api.signIn(callers[1].email, 'x');
    expect((await api.getMyScript()).isPersonal).toBe(false);
    await api.saveMyScript('Second caller');
    await api.signIn(callers[0].email, 'x');
    expect((await api.getMyScript()).script).toBe('First caller');
    const team = (await api.getSettings()).script;
    expect((await api.getMyScript()).teamScript).toBe(team);
    // Admins have their own copy too.
    await api.signInDemo('admin');
    expect((await api.getMyScript()).isPersonal).toBe(false);
    expect((await api.getSettings()).script).toBe(team);
  });

  it('requires a session and rejects over-long scripts', async () => {
    const { api } = makeApi();
    await expect(api.getMyScript()).rejects.toMatchObject({ code: 'not_authenticated' });
    await expect(api.saveMyScript('x')).rejects.toMatchObject({ code: 'not_authenticated' });
    await api.signInDemo('caller');
    await expect(api.saveMyScript('x'.repeat(20_001))).rejects.toMatchObject({ code: 'invalid' });
    expect((await api.getMyScript()).isPersonal).toBe(false);
  });

  it('persists with the rest of the demo state and loads state saved before the field existed', async () => {
    const storage = memoryStorage();
    const a = new DemoApi({ storage, now: () => NOW, simulatePresence: false, empty: true });
    await a.signInDemo('caller');
    await a.saveMyScript('Persisted');
    a.flush();
    const b = new DemoApi({ storage, now: () => NOW, simulatePresence: false, empty: true });
    expect(await b.getMyScript()).toMatchObject({ script: 'Persisted', isPersonal: true });

    // Old saved state without callerScripts.
    const old = memoryStorage();
    const c = new DemoApi({ storage: old, now: () => NOW, simulatePresence: false, empty: true });
    await c.signInDemo('caller');
    const st = c.debugState();
    delete st.callerScripts;
    c.flush();
    const d = new DemoApi({ storage: old, now: () => NOW, simulatePresence: false, empty: true });
    expect((await d.getMyScript()).isPersonal).toBe(false);
    await d.saveMyScript('New');
    expect((await d.getMyScript()).script).toBe('New');
  });
});

describe('claimNextLeads', () => {
  it('orders own due callbacks, then assigned, then pool, and locks them', async () => {
    const { api, clock } = makeApi();
    const admin = await api.signInDemo('admin');
    expect(admin.role).toBe('admin');
    const users = await api.listUsers();
    const [c1, c2] = users.filter((u) => u.role === 'caller');

    const pool = await api.importLeads({ newListName: 'Pool', rows: rows(3, 'Pool', 100), assign: { mode: 'pool' } });
    clock.t += 1000;
    await api.importLeads({ listId: pool.listId, rows: rows(2, 'Mine', 200), assign: { mode: 'caller', callerId: c1.id } });
    await api.importLeads({ listId: pool.listId, rows: rows(2, 'Theirs', 300), assign: { mode: 'caller', callerId: c2.id } });
    const cbLead = (await api.queryLeads({ search: 'Pool 2', page: 1, pageSize: 5 })).rows[0];
    await api.updateLead(cbLead.id, { status: 'callback', callbackAt: new Date(NOW - 60_000).toISOString(), callbackOwner: c1.id });
    const futureCb = (await api.queryLeads({ search: 'Pool 1', page: 1, pageSize: 5 })).rows[0];
    await api.updateLead(futureCb.id, { status: 'callback', callbackAt: new Date(NOW + 3_600_000).toISOString(), callbackOwner: c1.id });
    const dnc = (await api.queryLeads({ search: 'Pool 0', page: 1, pageSize: 5 })).rows[0];
    await api.updateLead(dnc.id, { status: 'do_not_call' });

    await api.signIn(c1.email, 'x');
    const claimed = await api.claimNextLeads(10);
    expect(claimed.map((l) => l.businessName)).toEqual(['Pool 2', 'Mine 0', 'Mine 1']);
    expect(claimed.every((l) => l.lockedBy === c1.id)).toBe(true);

    // c2 cannot take c1's locked leads, only their own assigned ones.
    await api.signIn(c2.email, 'x');
    const c2Claim = await api.claimNextLeads(10);
    expect(c2Claim.map((l) => l.businessName)).toEqual(['Theirs 0', 'Theirs 1']);

    // Release c2's and make c1's locks stale: pool lead 'Pool 2' is a c1 callback, so still not c2's.
    await api.releaseLeads(c2Claim.map((l) => l.id));
    clock.t += 11 * 60_000;
    const again = await api.claimNextLeads(10);
    expect(again.map((l) => l.businessName)).toEqual(['Theirs 0', 'Theirs 1']);
  });

  it('skips leads locked by someone else unless the lock is older than 10 minutes', async () => {
    const { api, clock } = makeApi();
    await api.signInDemo('admin');
    const [c1, c2] = (await api.listUsers()).filter((u) => u.role === 'caller');
    await api.importLeads({ newListName: 'Pool', rows: rows(2, 'P'), assign: { mode: 'pool' } });

    await api.signIn(c1.email, 'x');
    expect((await api.claimNextLeads(2)).length).toBe(2);

    await api.signIn(c2.email, 'x');
    expect(await api.claimNextLeads(2)).toEqual([]);
    clock.t += 9 * 60_000;
    expect(await api.claimNextLeads(2)).toEqual([]);
    clock.t += 2 * 60_000;
    const stolen = await api.claimNextLeads(2);
    expect(stolen.length).toBe(2);
    expect(stolen[0].lockedBy).toBe(c2.id);
  });

  it('does not return leads whose nextCallAt is in the future', async () => {
    const { api, clock } = makeApi();
    await api.signInDemo('caller');
    const me = (await api.getSession())!;
    await api.signInDemo('admin');
    await api.importLeads({ newListName: 'L', rows: rows(1, 'A'), assign: { mode: 'caller', callerId: me.id } });
    await api.signIn(me.email, 'x');
    const [lead] = await api.claimNextLeads(1);
    await api.reportMissedDay(lead.id);
    expect(await api.claimNextLeads(1)).toEqual([]);
    clock.t = startOfNextDay(NOW).getTime() + 9 * 3_600_000;
    expect((await api.claimNextLeads(1)).map((l) => l.id)).toEqual([lead.id]);
  });
});

describe('reportMissedDay', () => {
  it('becomes exhausted after retryDays missed days', async () => {
    const { api, clock } = makeApi();
    await api.signInDemo('admin');
    const settings = await api.getSettings();
    expect(settings.retryDays).toBe(3);
    await api.importLeads({ newListName: 'L', rows: rows(1, 'A'), assign: { mode: 'pool' } });
    await api.signInDemo('caller');

    for (let day = 1; day <= 3; day++) {
      const [lead] = await api.claimNextLeads(1);
      expect(lead).toBeDefined();
      const after = await api.reportMissedDay(lead.id);
      expect(after.attemptDays).toBe(day);
      expect(after.lockedBy).toBeNull();
      if (day < 3) {
        expect(after.status).toBe('no_answer');
        expect(after.nextCallAt).toBe(startOfNextDay(clock.t).toISOString());
      } else {
        expect(after.status).toBe('exhausted');
        expect(after.nextCallAt).toBeNull();
      }
      clock.t = addDays(startOfDay(clock.t), 1).getTime() + 10 * 3_600_000;
    }
    expect(await api.claimNextLeads(1)).toEqual([]);
  });
});

describe('saveDisposition', () => {
  async function setup() {
    const ctx = makeApi();
    await ctx.api.signInDemo('admin');
    await ctx.api.importLeads({ newListName: 'L', rows: rows(8, 'D'), assign: { mode: 'pool' } });
    const caller = await ctx.api.signInDemo('caller');
    return { ...ctx, caller };
  }

  async function dispo(api: DemoApi, disposition: Parameters<DemoApi['saveDisposition']>[0]['disposition'], callbackAt?: string) {
    const [lead] = await api.claimNextLeads(1);
    const call = await api.createCall({ leadId: lead.id, direction: 'outbound', fromNumber: '+12145550100', toNumber: lead.phones[0], ring: 1, result: 'answered', talkSeconds: 45 });
    const updated = await api.saveDisposition({ callId: call.id, leadId: lead.id, disposition, notes: 'n', callbackAt });
    return { lead: updated, call };
  }

  it('applies the status rule and unlocks', async () => {
    const { api, caller } = await setup();
    for (const d of ['booked', 'not_interested', 'wrong_number', 'do_not_call'] as const) {
      const { lead } = await dispo(api, d);
      expect(lead.status).toBe(d);
      expect(lead.lockedBy).toBeNull();
      expect(lead.lastCalledBy).toBe(caller.id);
      expect(lead.nextCallAt).toBeNull();
    }
  });

  it('callback requires callbackAt and assigns ownership', async () => {
    const { api, caller } = await setup();
    const [lead] = await api.claimNextLeads(1);
    const call = await api.createCall({ leadId: lead.id, direction: 'outbound', fromNumber: '+12145550100', toNumber: lead.phones[0], ring: 1 });
    await expect(api.saveDisposition({ callId: call.id, leadId: lead.id, disposition: 'callback', notes: '' })).rejects.toMatchObject({ code: 'invalid' });
    const at = new Date(NOW + 86_400_000).toISOString();
    const after = await api.saveDisposition({ callId: call.id, leadId: lead.id, disposition: 'callback', notes: '', callbackAt: at });
    expect(after.status).toBe('callback');
    expect(after.callbackOwner).toBe(caller.id);
    expect(after.callbackAt).toBe(at);
    expect(after.nextCallAt).toBe(at);
    expect((await api.getMyCallbacks()).map((l) => l.id)).toContain(lead.id);
    const history = await api.getLeadHistory(lead.id);
    expect(history[0].disposition).toBe('callback');
  });

  it('voicemail and hung_up count as a missed day', async () => {
    const { api } = await setup();
    for (const d of ['voicemail', 'hung_up'] as const) {
      const { lead } = await dispo(api, d);
      expect(lead.status).toBe('no_answer');
      expect(lead.attemptDays).toBe(1);
      expect(lead.nextCallAt).toBe(startOfNextDay(NOW).toISOString());
    }
  });

  it('reportBadNumber removes the phone and marks bad_number when none left', async () => {
    const { api } = await setup();
    const [lead] = await api.claimNextLeads(1);
    const after = await api.reportBadNumber(lead.id, lead.phones[0]);
    expect(after.phones).toEqual([]);
    expect(after.status).toBe('bad_number');
  });
});

describe('importLeads', () => {
  it('dedupes on primary phone and rejects invalid rows', async () => {
    const { api } = makeApi();
    await api.signInDemo('admin');
    const first = await api.importLeads({ newListName: 'A', rows: rows(3, 'X'), assign: { mode: 'pool' } });
    expect(first).toMatchObject({ imported: 3, duplicates: 0, invalid: 0 });
    const second = await api.importLeads({
      listId: first.listId,
      rows: [...rows(2, 'Y'), { businessName: 'No phone', phones: ['123'] }, { businessName: '', phones: ['2145550199'] }, { businessName: 'Fresh', phones: ['+1 (214) 555-0150'] }],
      assign: { mode: 'pool' },
    });
    expect(second).toMatchObject({ imported: 1, duplicates: 2, invalid: 2 });
    const lists = await api.listLeadLists();
    expect(lists.find((l) => l.id === first.listId)?.leadCount).toBe(4);
  });

  it('round robin distributes evenly', async () => {
    const { api } = makeApi();
    await api.signInDemo('admin');
    const callers = (await api.listUsers()).filter((u) => u.role === 'caller');
    await api.importLeads({ newListName: 'RR', rows: rows(9, 'R'), assign: { mode: 'round_robin', callerIds: callers.map((c) => c.id) } });
    for (const c of callers) {
      expect((await api.queryLeads({ assignedTo: c.id, page: 1, pageSize: 50 })).total).toBe(3);
    }
  });
});

describe('pickFromNumber', () => {
  it('prefers same area code, then fewest calls today, and respects ramped caps', async () => {
    const { api } = makeApi();
    await api.signInDemo('admin');
    const numbers = await api.listNumbers();
    // Seeded: two 214 numbers, both fully ramped.
    const dallas = numbers.filter((n) => n.number.startsWith('+1214'));
    expect(dallas.length).toBe(2);
    const settings = await api.getSettings();
    const brandNew = numbers.find((n) => n.label.includes('Las Vegas'))!;
    expect(brandNew.effectiveCapToday).toBe(settings.rampStartCap);
    const phoenix = numbers.find((n) => n.label.includes('Phoenix'))!; // added 10 days ago
    expect(phoenix.effectiveCapToday).toBe(Math.round(25 + (75 * 10) / 14));
    expect(dallas[0].effectiveCapToday).toBe(dallas[0].dailyCap);

    await api.signInDemo('caller');
    const first = await api.pickFromNumber('+12145550177');
    expect(first?.number.startsWith('+1214')).toBe(true);
    await api.createCall({ leadId: null, direction: 'outbound', fromNumber: first!.number, toNumber: '+12145550177', ring: 1, result: 'no_answer' });
    const second = await api.pickFromNumber('+12145550177');
    expect(second?.number.startsWith('+1214')).toBe(true);
    expect(second?.id).not.toBe(first?.id);

    // Unknown area code -> any number with the fewest calls today.
    const other = await api.pickFromNumber('+19195550111');
    expect(other).not.toBeNull();
    expect(other!.callsToday).toBe(0);
  });

  it('skips numbers at their cap and returns null when all are capped or inactive', async () => {
    const { api } = makeApi();
    await api.signInDemo('admin');
    const numbers = await api.listNumbers();
    for (const n of numbers) await api.updateNumber(n.id, { active: n.label.includes('Las Vegas') });
    const vegas = numbers.find((n) => n.label.includes('Las Vegas'))!;
    await api.signInDemo('caller');
    for (let i = 0; i < vegas.effectiveCapToday; i++) {
      const pick = await api.pickFromNumber('+12145550111');
      expect(pick?.id).toBe(vegas.id);
      await api.createCall({ leadId: null, direction: 'outbound', fromNumber: vegas.number, toNumber: '+12145550111', ring: 1, result: 'no_answer' });
    }
    expect(await api.pickFromNumber('+12145550111')).toBeNull();
  });
});

describe('seeded data & metrics', () => {
  it('has the expected seed volume and consistent metrics', async () => {
    const api = new DemoApi({ storage: null, now: () => NOW, simulatePresence: false });
    await api.signInDemo('admin');
    const state = api.debugState();
    expect(state.users.filter((u) => u.role === 'caller').length).toBe(3);
    expect(state.numbers.length).toBe(10);
    expect(state.calls.length).toBeGreaterThan(2000);
    expect(state.calls.length).toBeLessThan(4000);
    expect(state.calls.some((c) => c.recordingUrl)).toBe(true);
    expect(state.calls.some((c) => c.result === 'dropped_pickup')).toBe(true);

    const from = addDays(startOfDay(NOW), -14).toISOString();
    const to = startOfNextDay(NOW).toISOString();
    const m = await api.getMetrics({ from, to });
    expect(m.totals.dials).toBeGreaterThan(0);
    expect(m.totals.pickupRate).toBeGreaterThan(0.06);
    expect(m.totals.pickupRate).toBeLessThan(0.14);
    expect(m.totals.bookings).toBeLessThan(m.totals.conversations);

    const sum = (rows: { dials: number }[]) => rows.reduce((s, r) => s + r.dials, 0);
    expect(sum(m.byCaller)).toBe(m.totals.dials);
    expect(sum(m.byDay)).toBe(m.totals.dials);
    expect(sum(m.byNumber)).toBe(m.totals.dials);
    expect(sum(m.byList)).toBe(m.totals.dials);
    expect(m.byDay.length).toBe(15);
    expect(m.outcomes.reduce((s, o) => s + o.count, 0)).toBe(state.calls.filter((c) => c.startedAt >= from && c.startedAt < to && c.disposition).length);

    const numbers = await api.listNumbers();
    expect(numbers.filter((n) => n.flagged).map((n) => n.label)).toEqual(['Miami']);
  });

  it('getMyStatsToday only counts my calls since midnight', async () => {
    const { api } = makeApi();
    const me = await api.signInDemo('caller');
    await api.createCall({ leadId: null, direction: 'outbound', fromNumber: '+12145550100', toNumber: '+12145550111', ring: 1, result: 'answered', talkSeconds: 30 });
    await api.createCall({ leadId: null, direction: 'outbound', fromNumber: '+12145550100', toNumber: '+12145550112', ring: 1, result: 'no_answer', startedAt: new Date(NOW - 2 * 86_400_000).toISOString() });
    const stats = await api.getMyStatsToday();
    expect(stats).toMatchObject({ dials: 1, pickups: 1, conversations: 1, talkSeconds: 30 });
    expect(me.role).toBe('caller');
  });
});

describe('demo api: username sign-in', () => {
  it('signs in with a bare username, its internal address, or the full demo address', async () => {
    const { api } = makeApi();
    expect((await api.signIn('admin', 'x')).role).toBe('admin');
    expect((await api.signIn('jordan@questlabsco.com', 'x')).email).toBe('jordan@questlabs.demo');
    expect((await api.signIn(' Jordan ', 'x')).role).toBe('caller');
    expect((await api.signIn('admin@questlabs.demo', 'x')).role).toBe('admin');
  });

  it('says "Wrong username or password" for unknown users or a missing password', async () => {
    const { api } = makeApi();
    await expect(api.signIn('nobody', 'x')).rejects.toMatchObject({ code: 'invalid', message: 'Wrong username or password.' });
    await expect(api.signIn('admin', '')).rejects.toMatchObject({ message: 'Wrong username or password.' });
    await expect(api.signIn('admin@elsewhere.com', 'x')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('creates users by internal address, signs them in by username, and rejects taken usernames', async () => {
    const { api } = makeApi();
    await api.signInDemo('admin');
    const u = await api.createUser({ fullName: 'Casey P', email: 'casey@questlabsco.com', role: 'caller', password: 'longenough' });
    expect(u.email).toBe('casey@questlabsco.com');
    await expect(api.createUser({ fullName: 'Dup', email: 'casey@questlabsco.com', role: 'caller', password: 'longenough' })).rejects.toMatchObject({
      code: 'conflict',
      message: 'That username is taken.',
    });
    // The same username as a demo account counts as taken too.
    await expect(api.createUser({ fullName: 'Dup', email: 'jordan@questlabsco.com', role: 'caller', password: 'longenough' })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect((await api.signIn('casey', 'x')).id).toBe(u.id);
  });
});

describe('demo api: temporary passwords', () => {
  it('flags a new person until they change their password', async () => {
    const { api } = makeApi();
    await api.signInDemo('admin');
    expect(api.mustChangePassword()).toBe(false);
    const u = await api.createUser({ email: 'newbie@questlabsco.com', fullName: 'New Person', role: 'caller', password: 'temp-pass-1' });
    expect(api.mustChangePassword()).toBe(false); // the admin is not affected
    await api.signOut();
    expect(api.mustChangePassword()).toBe(false);

    const me = await api.signIn('newbie', 'temp-pass-1');
    expect(me.id).toBe(u.id);
    expect(api.mustChangePassword()).toBe(true);
    await api.changeMyPassword({ currentPassword: 'temp-pass-1', newPassword: 'my-own-pass' });
    expect(api.mustChangePassword()).toBe(false);

    await api.signOut();
    await api.signIn('newbie', 'my-own-pass');
    expect(api.mustChangePassword()).toBe(false);
  });

  it('sets the flag again when an admin resets the password', async () => {
    const { api } = makeApi();
    await api.signInDemo('admin');
    const u = await api.createUser({ email: 'reset.me@questlabsco.com', fullName: 'Reset Me', role: 'caller', password: 'temp-pass-1' });
    expect(api.debugState().mustChangePassword?.[u.id]).toBe(true);
    await api.signOut();
    await api.signIn('reset.me', 'temp-pass-1');
    await api.changeMyPassword({ currentPassword: 'temp-pass-1', newPassword: 'my-own-pass' });
    expect(api.debugState().mustChangePassword?.[u.id]).toBeUndefined();
    await api.signOut();

    await api.signInDemo('admin');
    await api.resetPassword(u.id, 'another-temp');
    await api.signOut();
    await api.signIn('reset.me', 'another-temp');
    expect(api.mustChangePassword()).toBe(true);
  });

  it('rejects bad changes with plain messages and keeps the flag', async () => {
    const { api } = makeApi();
    await expect(api.changeMyPassword({ currentPassword: 'a', newPassword: 'long-enough' })).rejects.toMatchObject({ code: 'not_authenticated' });
    await api.signInDemo('admin');
    const u = await api.createUser({ email: 'err@questlabsco.com', fullName: 'Err', role: 'caller', password: 'temp-pass-1' });
    await api.signOut();
    await api.signIn('err', 'temp-pass-1');
    await expect(api.changeMyPassword({ currentPassword: '', newPassword: 'long-enough' })).rejects.toMatchObject({ code: 'invalid', message: 'Current password is wrong' });
    await expect(api.changeMyPassword({ currentPassword: 'temp-pass-1', newPassword: 'short' })).rejects.toMatchObject({ code: 'invalid', message: 'At least 8 characters' });
    await expect(api.changeMyPassword({ currentPassword: 'temp-pass-1', newPassword: 'temp-pass-1' })).rejects.toMatchObject({
      code: 'invalid',
      message: 'Must be different from your current password',
    });
    expect(api.mustChangePassword()).toBe(true);
    expect(api.debugState().mustChangePassword?.[u.id]).toBe(true);
  });
});
