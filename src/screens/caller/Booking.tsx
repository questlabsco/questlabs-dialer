/**
 * In-app Calendly booking: a "Book meeting" button that opens the admin's Calendly scheduling page
 * inside a modal (Calendly inline-embed URL form, name/email prefilled) and shows a "Booked" state
 * when Calendly reports `calendly.event_scheduled` via postMessage.
 *
 * Calendly references (checked 2026-11):
 * - Prefill params `name`, `email`, `a1`..: calendly.com/help/how-to-pre-fill-invitee-information-in-your-calendly-link
 * - Parent-window events: developer.calendly.com/api-docs/overview/embedding/notifying-the-parent-window
 * - `embed_domain` / `embed_type=Inline` are what Calendly's own widget.js appends for an inline embed;
 *   a bare iframe without them gets no postMessage events. `hide_gdpr_banner=1` only works in embeds.
 */
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import type { Settings } from '../../types';
import { Button, Modal, Spinner } from '../../components/ui';
import { openExternal } from '../../lib/desktop';
import { isCalendlyConfigured } from './dialerLogic';
import './booking.css';

export interface BookMeetingButtonProps {
  name: string;
  email: string;
  businessName: string;
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md';
}

// ---------------------------------------------------------------------------
// Pure helpers (tested in booking.test.ts)
// ---------------------------------------------------------------------------

export interface Invitee {
  name: string;
  email: string;
  businessName: string;
}

/**
 * Calendly fills custom questions in order with a1, a2, ... The business name goes into `a1`, i.e.
 * the admin's FIRST custom booking question (it should be "Business name"). Set to null to stop.
 */
export const BUSINESS_NAME_ANSWER_PARAM: string | null = 'a1';

/** True for https://calendly.com and its subdomains. */
export function isCalendlyOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && (u.hostname === 'calendly.com' || u.hostname.endsWith('.calendly.com'));
  } catch {
    return false;
  }
}

/**
 * The admin's scheduling link with the invitee prefilled. With `embedDomain` set it is the inline
 * embed form (embed_domain, embed_type=Inline, hide_gdpr_banner=1); without it, a plain link for
 * the system browser. Only name, email and business name are added. Params already in the admin's
 * link are kept unless we set them. Returns null for a link that is not a usable Calendly URL.
 */
export function buildCalendlyUrl(baseUrl: string, invitee: Invitee, embedDomain?: string | null): string | null {
  if (!isCalendlyConfigured(baseUrl)) return null;
  let u: URL;
  try {
    u = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (!isCalendlyOrigin(u.origin)) return null;
  const name = invitee.name.trim();
  const email = invitee.email.trim();
  const business = invitee.businessName.trim();
  if (name) u.searchParams.set('name', name);
  if (email) u.searchParams.set('email', email);
  if (business && BUSINESS_NAME_ANSWER_PARAM && !u.searchParams.has(BUSINESS_NAME_ANSWER_PARAM)) {
    u.searchParams.set(BUSINESS_NAME_ANSWER_PARAM, business);
  }
  if (embedDomain !== undefined) {
    u.searchParams.set('embed_domain', embedDomain || 'localhost');
    u.searchParams.set('embed_type', 'Inline');
    u.searchParams.set('hide_gdpr_banner', '1');
  }
  return u.toString();
}

export interface CalendlyMessage {
  event: string;
  payload: Record<string, unknown>;
}

/** Parses a postMessage event from Calendly, or null for anything else. */
export function parseCalendlyMessage(origin: string, data: unknown): CalendlyMessage | null {
  if (!isCalendlyOrigin(origin)) return null;
  if (!data || typeof data !== 'object') return null;
  const ev = (data as { event?: unknown }).event;
  if (typeof ev !== 'string' || !ev.startsWith('calendly.')) return null;
  const p = (data as { payload?: unknown }).payload;
  return { event: ev, payload: p && typeof p === 'object' ? (p as Record<string, unknown>) : {} };
}

export const CALENDLY_EVENT_SCHEDULED = 'calendly.event_scheduled';

/** Reads payload.event.uri / payload.invitee.uri from calendly.event_scheduled (either may be missing). */
export function scheduledUris(payload: Record<string, unknown>): { eventUri: string | null; inviteeUri: string | null } {
  const uri = (v: unknown) => {
    const u = v && typeof v === 'object' ? (v as { uri?: unknown }).uri : null;
    return typeof u === 'string' ? u : null;
  };
  return { eventUri: uri(payload.event), inviteeUri: uri(payload.invitee) };
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export interface MeetingBooked extends Invitee {
  /** Calendly API URIs from the event payload, when Calendly sends them. */
  eventUri: string | null;
  inviteeUri: string | null;
  at: string;
}

const bookedListeners = new Set<(b: MeetingBooked) => void>();

/** Called whenever a meeting is booked through a BookMeetingButton. Returns unsubscribe. */
export function onMeetingBooked(listener: (b: MeetingBooked) => void): () => void {
  bookedListeners.add(listener);
  return () => {
    bookedListeners.delete(listener);
  };
}

/** Internal; exported for tests. */
export function emitMeetingBooked(b: MeetingBooked): void {
  for (const l of [...bookedListeners]) {
    try {
      l(b);
    } catch {
      /* a listener's error must not break booking */
    }
  }
}

const calendlyListeners = new Set<(m: CalendlyMessage) => void>();

/** Every Calendly message seen by an open booking modal (dev/diagnostics). Returns unsubscribe. */
export function onCalendlyMessage(listener: (m: CalendlyMessage) => void): () => void {
  calendlyListeners.add(listener);
  return () => {
    calendlyListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Settings cache (callers may read settings; don't refetch on every render)
// ---------------------------------------------------------------------------

const SETTINGS_TTL_MS = 60_000;
let settingsCache: { at: number; promise: Promise<Settings> } | null = null;
let authHooked = false;

function loadSettings(force = false): Promise<Settings> {
  if (!authHooked) {
    authHooked = true;
    api.onAuthChange(() => {
      settingsCache = null;
    });
  }
  if (!force && settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.promise;
  const promise = api.getSettings();
  const entry = { at: Date.now(), promise };
  settingsCache = entry;
  promise.catch(() => {
    if (settingsCache === entry) settingsCache = null;
  });
  return promise;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

type Phase =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'not_configured' }
  | { kind: 'error'; message: string }
  | { kind: 'open'; embedUrl: string; browserUrl: string };

function embedDomain(): string {
  return (typeof window !== 'undefined' && window.location.host) || 'localhost';
}

export function BookMeetingButton({ name, email, businessName, variant = 'primary', size = 'md' }: BookMeetingButtonProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'closed' });
  const invitee: Invitee = { name, email, businessName };
  const reqRef = useRef(0);

  // Warm the cache so the first click is instant.
  useEffect(() => {
    loadSettings().catch(() => undefined);
  }, []);

  const open = async () => {
    const req = ++reqRef.current;
    setPhase({ kind: 'loading' });
    try {
      const s = await loadSettings();
      if (req !== reqRef.current) return;
      const embedUrl = buildCalendlyUrl(s.calendlyUrl, invitee, embedDomain());
      const browserUrl = buildCalendlyUrl(s.calendlyUrl, invitee);
      if (!embedUrl || !browserUrl) setPhase({ kind: 'not_configured' });
      else setPhase({ kind: 'open', embedUrl, browserUrl });
    } catch (e) {
      if (req !== reqRef.current) return;
      setPhase({ kind: 'error', message: errorMessage(e) });
    }
  };

  const close = () => {
    reqRef.current++;
    setPhase({ kind: 'closed' });
  };

  return (
    <>
      <Button variant={variant} size={size} type="button" onClick={() => void open()} loading={phase.kind === 'loading'}>
        Book meeting
      </Button>
      {(phase.kind === 'not_configured' || phase.kind === 'error') && (
        <Modal
          open
          onClose={close}
          title="Book meeting"
          size="sm"
          footer={
            <Button variant="primary" onClick={close} data-autofocus>
              OK
            </Button>
          }
        >
          <p className="bk-note">
            {phase.kind === 'not_configured'
              ? 'Booking isn’t set up yet: an admin needs to add the Calendly booking link in Settings.'
              : `Couldn't load the booking link: ${phase.message}`}
          </p>
        </Modal>
      )}
      {phase.kind === 'open' && <BookingModal invitee={invitee} embedUrl={phase.embedUrl} browserUrl={phase.browserUrl} onClose={close} />}
    </>
  );
}

const SLOW_LOAD_MS = 15_000;

function BookingModal({ invitee, embedUrl, browserUrl, onClose }: { invitee: Invitee; embedUrl: string; browserUrl: string; onClose: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const [booked, setBooked] = useState<MeetingBooked | null>(null);
  const inviteeRef = useRef(invitee);
  inviteeRef.current = invitee;
  const bookedOnce = useRef(false);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (frameRef.current && e.source !== frameRef.current.contentWindow) return;
      const msg = parseCalendlyMessage(e.origin, e.data);
      if (!msg) return;
      for (const l of [...calendlyListeners]) l(msg);
      if (msg.event === CALENDLY_EVENT_SCHEDULED) {
        if (bookedOnce.current) return;
        bookedOnce.current = true;
        const b: MeetingBooked = { ...inviteeRef.current, ...scheduledUris(msg.payload), at: new Date().toISOString() };
        setBooked(b);
        emitMeetingBooked(b);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (loaded) return;
    const t = setTimeout(() => setSlow(true), SLOW_LOAD_MS);
    return () => clearTimeout(t);
  }, [loaded]);

  const who = invitee.name.trim() || 'this lead';
  const details = [invitee.businessName.trim(), invitee.email.trim() || 'no email on file'].filter(Boolean).join(' · ');

  return (
    <Modal open onClose={onClose} title={booked ? 'Meeting booked' : 'Book meeting'} size="lg">
      <div className="bk">
        <div className="bk-head">
          <div className="bk-who">
            <span className="bk-who-label">{booked ? 'Booked:' : 'Booking for'}</span> <strong>{who}</strong>
            {details && <span className="bk-who-detail"> · {details}</span>}
          </div>
          <div className="bk-head-actions">
            <Button size="sm" onClick={() => openExternal(browserUrl)} title="Open this booking page in your web browser">
              Open in browser
            </Button>
            <Button size="sm" variant={booked ? 'primary' : 'secondary'} onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
        {booked && (
          <div className="bk-booked" role="status">
            <strong>Booked.</strong> {who} is on the calendar. Calendly emails the confirmation. You can close this window.
          </div>
        )}
        {!loaded && (
          <div className="bk-loading muted">
            <Spinner size={14} /> Loading booking page
            {slow && <span> · Taking a while? Use “Open in browser”.</span>}
          </div>
        )}
        <iframe
          ref={frameRef}
          className={`bk-frame${loaded ? '' : ' bk-frame-loading'}`}
          title="Calendly booking page"
          src={embedUrl}
          onLoad={() => setLoaded(true)}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-storage-access-by-user-activation"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    </Modal>
  );
}
