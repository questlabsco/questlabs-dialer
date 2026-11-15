import { describe, expect, it } from 'vitest';
import {
  buildCalendlyUrl,
  emitMeetingBooked,
  isCalendlyOrigin,
  onMeetingBooked,
  parseCalendlyMessage,
  scheduledUris,
  type MeetingBooked,
} from './Booking';
import { DEFAULT_SETTINGS } from '../../types';

const who = { name: 'Dana Ortiz', email: 'dana@acme.co', businessName: 'Acme & Sons' };

describe('buildCalendlyUrl', () => {
  it('builds the inline-embed form with prefill', () => {
    const u = new URL(buildCalendlyUrl('https://calendly.com/questlabs/intro', who, 'localhost:5187')!);
    expect(u.origin + u.pathname).toBe('https://calendly.com/questlabs/intro');
    expect(u.searchParams.get('name')).toBe('Dana Ortiz');
    expect(u.searchParams.get('email')).toBe('dana@acme.co');
    expect(u.searchParams.get('a1')).toBe('Acme & Sons');
    expect(u.searchParams.get('embed_domain')).toBe('localhost:5187');
    expect(u.searchParams.get('embed_type')).toBe('Inline');
    expect(u.searchParams.get('hide_gdpr_banner')).toBe('1');
    // Nothing else about the lead.
    expect([...u.searchParams.keys()].sort()).toEqual(['a1', 'email', 'embed_domain', 'embed_type', 'hide_gdpr_banner', 'name']);
  });

  it('builds a plain browser link without embed params', () => {
    const u = new URL(buildCalendlyUrl('https://calendly.com/questlabs/intro', who)!);
    expect(u.searchParams.has('embed_type')).toBe(false);
    expect(u.searchParams.has('embed_domain')).toBe(false);
    expect(u.searchParams.get('email')).toBe('dana@acme.co');
  });

  it('skips blank fields and keeps the admin’s own params', () => {
    const u = new URL(buildCalendlyUrl('https://calendly.com/x/30min?month=2026-12&a1=Preset', { name: ' ', email: '', businessName: 'Biz' }, '')!);
    expect(u.searchParams.has('name')).toBe(false);
    expect(u.searchParams.has('email')).toBe(false);
    expect(u.searchParams.get('a1')).toBe('Preset');
    expect(u.searchParams.get('month')).toBe('2026-12');
    expect(u.searchParams.get('embed_domain')).toBe('localhost');
  });

  it('works with the shipped default link', () => {
    expect(DEFAULT_SETTINGS.calendlyUrl).toBe('https://calendly.com/questlabsco/questlabs');
    const u = new URL(buildCalendlyUrl(DEFAULT_SETTINGS.calendlyUrl, who, 'localhost')!);
    expect(u.pathname).toBe('/questlabsco/questlabs');
  });

  it('upgrades http and rejects placeholders, junk and non-Calendly hosts', () => {
    expect(buildCalendlyUrl('http://calendly.com/x', who)!.startsWith('https://calendly.com/x')).toBe(true);
    expect(buildCalendlyUrl('', who)).toBeNull();
    expect(buildCalendlyUrl('https://calendly.com/your-link', who)).toBeNull();
    expect(buildCalendlyUrl('not a url', who)).toBeNull();
    expect(buildCalendlyUrl('https://evil.example.com/calendly.com', who)).toBeNull();
    expect(buildCalendlyUrl('https://calendly.com.evil.io/x', who)).toBeNull();
  });
});

describe('Calendly messages', () => {
  it('accepts only calendly.* events from Calendly origins', () => {
    expect(isCalendlyOrigin('https://calendly.com')).toBe(true);
    expect(isCalendlyOrigin('https://assets.calendly.com')).toBe(true);
    expect(isCalendlyOrigin('http://calendly.com')).toBe(false);
    expect(isCalendlyOrigin('https://calendly.com.evil.io')).toBe(false);
    expect(parseCalendlyMessage('https://calendly.com', { event: 'calendly.event_scheduled', payload: { event: { uri: 'e' } } })).toEqual({
      event: 'calendly.event_scheduled',
      payload: { event: { uri: 'e' } },
    });
    expect(parseCalendlyMessage('https://evil.io', { event: 'calendly.event_scheduled' })).toBeNull();
    expect(parseCalendlyMessage('https://calendly.com', { event: 'other' })).toBeNull();
    expect(parseCalendlyMessage('https://calendly.com', 'calendly.event_scheduled')).toBeNull();
    expect(parseCalendlyMessage('https://calendly.com', { event: 'calendly.page_height' })).toEqual({ event: 'calendly.page_height', payload: {} });
  });

  it('reads the scheduled URIs when present', () => {
    expect(scheduledUris({ event: { uri: 'https://api.calendly.com/scheduled_events/1' }, invitee: { uri: 'i' } })).toEqual({
      eventUri: 'https://api.calendly.com/scheduled_events/1',
      inviteeUri: 'i',
    });
    expect(scheduledUris({})).toEqual({ eventUri: null, inviteeUri: null });
  });

  it('onMeetingBooked subscribes and unsubscribes; a throwing listener does not stop others', () => {
    const got: MeetingBooked[] = [];
    const offBad = onMeetingBooked(() => {
      throw new Error('x');
    });
    const off = onMeetingBooked((b) => got.push(b));
    const b: MeetingBooked = { ...who, eventUri: null, inviteeUri: null, at: '2026-11-15T00:00:00.000Z' };
    emitMeetingBooked(b);
    off();
    offBad();
    emitMeetingBooked(b);
    expect(got).toEqual([b]);
  });
});
