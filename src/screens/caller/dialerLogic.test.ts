import { describe, expect, it } from 'vitest';
import { DISPOSITIONS, type Lead } from '../../types';
import {
  callbackQuickPicks,
  countDueCallbacks,
  dispositionForHotkey,
  groupCallbacks,
  isCalendlyConfigured,
  isEditableTarget,
  isFutureTime,
  isUnknownLead,
  isValidEmail,
  renderScript,
  resolveShortcut,
  secondsSince,
  wrapUpValidation,
  type ShortcutInput,
} from './dialerLogic';

// Wednesday 2026-11-11 14:23:45.500 local.
const NOW = new Date(2026, 10, 11, 14, 23, 45, 500).getTime();

function lead(id: string, callbackAt: string | null): Lead {
  return {
    id,
    listId: 'l',
    businessName: id,
    contactName: '',
    phones: ['+12145550100'],
    email: '',
    city: '',
    state: '',
    notes: '',
    status: 'callback',
    assignedTo: null,
    attemptDays: 0,
    lastCalledAt: null,
    lastCalledBy: null,
    nextCallAt: callbackAt,
    callbackAt,
    callbackOwner: 'me',
    lockedBy: null,
    lockedAt: null,
    createdAt: new Date(NOW - 86_400_000).toISOString(),
  };
}

describe('callback quick picks', () => {
  it('offers +1h, +3h and tomorrow 10:00 local, seconds zeroed', () => {
    const picks = callbackQuickPicks(NOW);
    expect(picks.map((p) => p.id)).toEqual(['in_1h', 'in_3h', 'tomorrow_10']);
    expect(new Date(picks[0].iso).getTime()).toBe(new Date(2026, 10, 11, 15, 23, 0, 0).getTime());
    expect(new Date(picks[1].iso).getTime()).toBe(new Date(2026, 10, 11, 17, 23, 0, 0).getTime());
    expect(new Date(picks[2].iso).getTime()).toBe(new Date(2026, 10, 12, 10, 0, 0, 0).getTime());
  });

  it('tomorrow is the next calendar day even late at night', () => {
    const late = new Date(2026, 10, 11, 23, 50).getTime();
    const tomorrow = new Date(callbackQuickPicks(late)[2].iso);
    expect([tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()]).toEqual([12, 10, 0]);
    // Across a month boundary.
    const endOfMonth = new Date(2026, 10, 30, 9, 0).getTime();
    const dec1 = new Date(callbackQuickPicks(endOfMonth)[2].iso);
    expect([dec1.getMonth(), dec1.getDate()]).toEqual([11, 1]);
  });

  it('all quick picks are in the future', () => {
    for (const p of callbackQuickPicks(NOW)) expect(isFutureTime(p.iso, NOW)).toBe(true);
  });
});

describe('wrap-up validation', () => {
  it('requires an outcome', () => {
    expect(wrapUpValidation(null, null, NOW)).toMatch(/outcome/i);
  });
  it('requires a future callback time only for callback', () => {
    expect(wrapUpValidation('callback', null, NOW)).toMatch(/call back/i);
    expect(wrapUpValidation('callback', new Date(NOW - 60_000).toISOString(), NOW)).toMatch(/future/i);
    expect(wrapUpValidation('callback', new Date(NOW + 60_000).toISOString(), NOW)).toBeNull();
    expect(wrapUpValidation('not_interested', null, NOW)).toBeNull();
    expect(wrapUpValidation('booked', null, NOW)).toBeNull();
  });
  it('rejects garbage times', () => {
    expect(isFutureTime('not a date', NOW)).toBe(false);
    expect(isFutureTime(null, NOW)).toBe(false);
  });
});

describe('grouping callbacks', () => {
  it('splits into overdue / due today / upcoming, sorted', () => {
    const leads = [
      lead('tomorrow', new Date(2026, 10, 12, 9, 0).toISOString()),
      lead('later-today', new Date(2026, 10, 11, 17, 0).toISOString()),
      lead('yesterday', new Date(2026, 10, 10, 9, 0).toISOString()),
      lead('missing', null),
      lead('an-hour-ago', new Date(2026, 10, 11, 13, 0).toISOString()),
      lead('just-before-midnight', new Date(2026, 10, 11, 23, 59).toISOString()),
      lead('midnight', new Date(2026, 10, 12, 0, 0).toISOString()),
    ];
    const g = groupCallbacks(leads, NOW);
    expect(g.overdue.map((l) => l.id)).toEqual(['missing', 'yesterday', 'an-hour-ago']);
    expect(g.today.map((l) => l.id)).toEqual(['later-today', 'just-before-midnight']);
    expect(g.upcoming.map((l) => l.id)).toEqual(['midnight', 'tomorrow']);
  });

  it('counts due callbacks', () => {
    const leads = [lead('a', new Date(NOW - 1).toISOString()), lead('b', new Date(NOW + 60_000).toISOString()), lead('c', new Date(NOW).toISOString())];
    expect(countDueCallbacks(leads, NOW)).toBe(2);
    expect(countDueCallbacks([], NOW)).toBe(0);
  });
});

describe('keyboard shortcuts', () => {
  const base: ShortcutInput = { key: '', ctrlKey: false, metaKey: false, altKey: false, inEditable: false, phase: 'connected' };

  it('maps every disposition hotkey 1-7', () => {
    expect(DISPOSITIONS.map((d) => d.hotkey)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    for (const d of DISPOSITIONS) {
      expect(dispositionForHotkey(d.hotkey)?.value).toBe(d.value);
      expect(resolveShortcut({ ...base, phase: 'wrap_up', key: d.hotkey })).toEqual({ type: 'pick', disposition: d.value });
    }
    expect(dispositionForHotkey('8')).toBeNull();
    expect(dispositionForHotkey('0')).toBeNull();
  });

  it('M / H during a call, case-insensitive', () => {
    expect(resolveShortcut({ ...base, key: 'm' })).toEqual({ type: 'mute' });
    expect(resolveShortcut({ ...base, key: 'M' })).toEqual({ type: 'mute' });
    expect(resolveShortcut({ ...base, key: 'h' })).toEqual({ type: 'hang_up' });
    expect(resolveShortcut({ ...base, key: '1' })).toBeNull();
  });

  it('ignores keys in other phases, in fields, and with modifiers', () => {
    expect(resolveShortcut({ ...base, phase: 'dialing', key: 'm' })).toBeNull();
    expect(resolveShortcut({ ...base, phase: 'idle', key: '1' })).toBeNull();
    expect(resolveShortcut({ ...base, phase: 'wrap_up', key: 'h' })).toBeNull();
    expect(resolveShortcut({ ...base, key: 'm', inEditable: true })).toBeNull();
    expect(resolveShortcut({ ...base, phase: 'wrap_up', key: '1', inEditable: true })).toBeNull();
    expect(resolveShortcut({ ...base, key: 'h', ctrlKey: true })).toBeNull();
    expect(resolveShortcut({ ...base, key: 'm', metaKey: true })).toBeNull();
    expect(resolveShortcut({ ...base, phase: 'wrap_up', key: '2', altKey: true })).toBeNull();
  });

  it('Ctrl/Cmd+Enter saves in wrap-up, even from the notes box', () => {
    expect(resolveShortcut({ ...base, phase: 'wrap_up', key: 'Enter', ctrlKey: true, inEditable: true })).toEqual({ type: 'save' });
    expect(resolveShortcut({ ...base, phase: 'wrap_up', key: 'Enter', metaKey: true })).toEqual({ type: 'save' });
    expect(resolveShortcut({ ...base, phase: 'wrap_up', key: 'Enter' })).toBeNull();
    expect(resolveShortcut({ ...base, phase: 'connected', key: 'Enter', ctrlKey: true })).toBeNull();
  });

  it('detects editable targets', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'textarea' })).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('misc helpers', () => {
  it('renders script placeholders with fallbacks', () => {
    const s = 'Hi {contactName}, this is {callerName} calling {businessName}. {unknown}';
    expect(renderScript(s, { contactName: 'Dana', callerName: 'Sam', businessName: 'Acme' })).toBe('Hi Dana, this is Sam calling Acme. {unknown}');
    expect(renderScript(s, { contactName: '', callerName: 'Sam', businessName: 'Acme' })).toBe('Hi there, this is Sam calling Acme. {unknown}');
  });

  it('knows when Calendly is configured', () => {
    expect(isCalendlyConfigured('')).toBe(false);
    expect(isCalendlyConfigured('https://calendly.com/your-link')).toBe(false);
    expect(isCalendlyConfigured('https://calendly.com/your-link/')).toBe(false);
    expect(isCalendlyConfigured('calendly.com/acme')).toBe(false);
    expect(isCalendlyConfigured('javascript:alert(1)')).toBe(false);
    expect(isCalendlyConfigured('https://calendly.com/questlabs/intro')).toBe(true);
  });

  it('validates emails, unknown leads and elapsed seconds', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isUnknownLead({ id: 'unknown:+12145550100' })).toBe(true);
    expect(isUnknownLead({ id: 'lead-1' })).toBe(false);
    expect(secondsSince(new Date(NOW - 65_400).toISOString(), NOW)).toBe(65);
    expect(secondsSince(new Date(NOW + 5_000).toISOString(), NOW)).toBe(0);
    expect(secondsSince(null, NOW)).toBe(0);
  });
});
