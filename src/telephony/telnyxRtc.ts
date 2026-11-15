/**
 * Thin wrapper around @telnyx/webrtc for the caller's single "agent leg": log in with a JWT, place
 * one parked call on the dialer's credential connection, play remote audio, mute and send DTMF.
 * Kept behind a small interface so TelnyxTelephony can be unit-tested without the SDK or a DOM.
 */
import { AGENT_LEG_DESTINATION, AGENT_SESSION_HEADER } from '../../supabase/functions/_shared/telnyxLogic';

export interface RtcAgentCall {
  /** Resolves when the SDK reports the call active (the server answered the parked leg). */
  readonly active: Promise<void>;
  setMuted(muted: boolean): void;
  dtmf(digits: string): void;
  hangup(): Promise<void>;
}

export interface RtcCallbacks {
  /** A failure that ends the WebRTC session (auth rejected, gave up reconnecting...). */
  onFatal(message: string, kind: 'auth' | 'network' | 'other'): void;
}

export interface StartAgentLegOptions {
  sessionId: string;
  clientState: string;
  muted: boolean;
  /** The agent call ended for any reason other than our own hangup(). */
  onEnded(cause: string): void;
}

export interface RtcClient {
  connect(token: string): Promise<void>;
  startAgentLeg(opts: StartAgentLegOptions): RtcAgentCall;
  disconnect(): Promise<void>;
}

export type RtcFactory = (callbacks: RtcCallbacks) => RtcClient;

/** Minimal shape of the SDK's Call we rely on (see node_modules/@telnyx/webrtc typings). */
interface SdkCall {
  id: string;
  state: string;
  cause?: string;
  causeCode?: number;
  muteAudio(): void;
  unmuteAudio(): void;
  dtmf(d: string): void;
  hangup(): Promise<void>;
}

interface SdkClient {
  on(event: string, cb: (...args: any[]) => void): unknown;
  off(event: string, cb?: (...args: any[]) => void): unknown;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  newCall(options: Record<string, unknown>): SdkCall;
}

const CONNECT_TIMEOUT_MS = 15_000;

function remoteAudioElement(): HTMLAudioElement | null {
  if (typeof document === 'undefined') return null;
  const id = 'quest-telnyx-remote-audio';
  let el = document.getElementById(id) as HTMLAudioElement | null;
  if (!el) {
    el = document.createElement('audio');
    el.id = id;
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    el.style.display = 'none';
    document.body.appendChild(el);
  }
  return el;
}

function describeSdkError(e: unknown): { message: string; kind: 'auth' | 'network' | 'other' } {
  const err = (e as { error?: { message?: string; name?: string; description?: string; code?: unknown } })?.error ?? e;
  const text = String(
    (err as { message?: string })?.message ?? (err as { description?: string })?.description ?? 'Unknown telephony error',
  );
  const lower = text.toLowerCase();
  if (/auth|login|token|credential|401|403|jwt/.test(lower)) return { message: text, kind: 'auth' };
  if (/socket|network|connect|timeout|offline/.test(lower)) return { message: text, kind: 'network' };
  return { message: text, kind: 'other' };
}

/** Real implementation backed by @telnyx/webrtc (loaded lazily so tests never import it). */
export const createTelnyxRtc: RtcFactory = (callbacks) => {
  let client: SdkClient | null = null;
  let ready = false;
  const calls = new Map<string, { call: SdkCall; onUpdate: (c: SdkCall) => void }>();

  const onNotification = (n: { type?: string; call?: SdkCall }) => {
    if (n?.type !== 'callUpdate' || !n.call) return;
    calls.get(n.call.id)?.onUpdate(n.call);
  };
  const onError = (e: unknown) => {
    if (!ready) return; // handled by connect()'s own listener
    const d = describeSdkError(e);
    callbacks.onFatal(d.message, d.kind);
  };

  return {
    async connect(token) {
      const { TelnyxRTC } = await import('@telnyx/webrtc');
      const c = new TelnyxRTC({ login_token: token }) as unknown as SdkClient;
      client = c;
      c.on('telnyx.notification', onNotification);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out connecting to Telnyx.')), CONNECT_TIMEOUT_MS);
        const onReady = () => {
          clearTimeout(timer);
          ready = true;
          c.off('telnyx.ready', onReady);
          c.off('telnyx.error', onFirstError);
          resolve();
        };
        const onFirstError = (e: unknown) => {
          clearTimeout(timer);
          c.off('telnyx.ready', onReady);
          c.off('telnyx.error', onFirstError);
          reject(new Error(`Could not sign in to Telnyx: ${describeSdkError(e).message}`));
        };
        c.on('telnyx.ready', onReady);
        c.on('telnyx.error', onFirstError);
        c.connect().catch(onFirstError);
      });
      c.on('telnyx.error', onError);
    },

    startAgentLeg(opts) {
      if (!client) throw new Error('Telnyx is not connected.');
      const audioEl = remoteAudioElement();
      let resolveActive!: () => void;
      let rejectActive!: (e: Error) => void;
      const active = new Promise<void>((res, rej) => {
        resolveActive = res;
        rejectActive = rej;
      });
      active.catch(() => {});
      let localHangup = false;
      let ended = false;
      const call = client.newCall({
        destinationNumber: AGENT_LEG_DESTINATION,
        audio: true,
        video: false,
        clientState: opts.clientState,
        customHeaders: [{ name: AGENT_SESSION_HEADER, value: opts.sessionId }],
        ...(audioEl ? { remoteElement: audioEl } : {}),
      });
      const onUpdate = (c: SdkCall) => {
        if (c.state === 'active') {
          if (opts.muted) c.muteAudio();
          resolveActive();
        }
        if ((c.state === 'hangup' || c.state === 'destroy') && !ended) {
          ended = true;
          calls.delete(c.id);
          const cause = c.cause ?? 'hangup';
          rejectActive(new Error(`The audio call ended (${cause}).`));
          if (!localHangup) opts.onEnded(cause);
        }
      };
      calls.set(call.id, { call, onUpdate });
      return {
        active,
        setMuted(muted) {
          if (muted) call.muteAudio();
          else call.unmuteAudio();
        },
        dtmf(digits) {
          for (const d of digits) call.dtmf(d);
        },
        async hangup() {
          localHangup = true;
          if (!ended) await call.hangup().catch(() => {});
        },
      };
    },

    async disconnect() {
      const c = client;
      client = null;
      ready = false;
      for (const { call } of calls.values()) await call.hangup().catch(() => {});
      calls.clear();
      if (c) {
        c.off('telnyx.notification', onNotification);
        c.off('telnyx.error', onError);
        await c.disconnect().catch(() => {});
      }
    },
  };
};
