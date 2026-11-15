/**
 * Public shape of the power dialer. The DialerScreen renders DialerState and calls DialerControls;
 * nothing else about the engine is public.
 */
import type { Disposition, Lead } from '../types';

export type DialerPhase =
  /** Not started (or stopped). */
  | 'idle'
  /** Connecting audio / claiming the first leads. */
  | 'starting'
  /** Lines are ringing; waiting for a pickup. */
  | 'dialing'
  /** Talking to a lead (activeCall set). */
  | 'connected'
  /** Call ended; waiting for submitDisposition (wrapUp set). */
  | 'wrap_up'
  /** Not dialing; resume() continues. */
  | 'paused'
  /** Fatal problem (see `error`); stop() or start() again. */
  | 'error';

export interface LineState {
  /** 0-based line slot (0..linesPerCaller-1). */
  index: number;
  status: 'empty' | 'ringing' | 'answered';
  lead: Lead | null;
  /** Lead phone being rung (E.164), '' when empty. */
  phone: string;
  /** Our outbound number (E.164), '' when empty. */
  fromNumber: string;
  ring: 1 | 2;
  /** Telephony call id, null when empty. */
  callId: string | null;
  /** ISO, when this ring started; null when empty. */
  startedAt: string | null;
}

export interface ActiveCall {
  lead: Lead;
  /** Telephony call id. */
  callId: string;
  /** CallRecord id (use for history / disposition). */
  callRecordId: string;
  fromNumber: string;
  toNumber: string;
  /** ISO. */
  answeredAt: string;
  muted: boolean;
  direction: 'outbound' | 'inbound';
}

export interface WrapUp {
  lead: Lead;
  /** CallRecord id the disposition is saved against. */
  callRecordId: string;
  talkSeconds: number;
}

export interface IncomingCall {
  /** Telephony call id. */
  callId: string;
  /** Caller id of the inbound party, E.164. */
  from: string;
  /** Matched lead (Api.findLeadByPhone), or null if unknown. */
  lead: Lead | null;
}

export interface DialerSessionStats {
  /** ISO when start() was pressed; null before. */
  startedAt: string | null;
  dials: number;
  pickups: number;
  conversations: number;
  bookings: number;
  talkSeconds: number;
}

export interface DialerState {
  phase: DialerPhase;
  /** Always linesPerCaller entries while running; [] when idle. */
  lines: LineState[];
  activeCall: ActiveCall | null;
  wrapUp: WrapUp | null;
  incoming: IncomingCall | null;
  /** True when claimNextLeads returned nothing and no line is busy. */
  queueEmpty: boolean;
  /** pause() was pressed during a call / wrap-up; the engine pauses once wrap-up is submitted. */
  pauseRequested: boolean;
  session: DialerSessionStats;
  error: string | null;
}

export interface SubmitDispositionInput {
  disposition: Disposition;
  notes: string;
  /** ISO; required for 'callback'. */
  callbackAt?: string | null;
}

export interface DialerControls {
  /** Connect audio, set presence, claim leads and start ringing. */
  start(): Promise<void>;
  /** Stop ringing new lines; during a call/wrap-up sets pauseRequested instead. */
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Hang up everything, release locks, go idle. */
  stop(): Promise<void>;
  /** End the active call (goes to wrap-up). */
  hangUp(): Promise<void>;
  toggleMute(): Promise<void>;
  sendDigits(digits: string): Promise<void>;
  /** Save the outcome for wrapUp and continue dialing (or pause if pauseRequested). */
  submitDisposition(input: SubmitDispositionInput): Promise<void>;
  answerIncoming(): Promise<void>;
  declineIncoming(): Promise<void>;
}

export const INITIAL_DIALER_STATE: DialerState = {
  phase: 'idle',
  lines: [],
  activeCall: null,
  wrapUp: null,
  incoming: null,
  queueEmpty: false,
  pauseRequested: false,
  session: { startedAt: null, dials: 0, pickups: 0, conversations: 0, bookings: 0, talkSeconds: 0 },
  error: null,
};
