/**
 * Typed wrappers for the admin-side Telnyx Edge Functions (Phone setup checklist, number sync /
 * assignment) and for recording playback. Response shapes match supabase/functions/telnyx-*.
 */
import {
  parseRecordingRef,
  type StatusItem,
} from '../../supabase/functions/_shared/telnyxLogic';
import { createSupabaseTelnyxBackend, type TelnyxBackend } from './telnyxBackend';

export type { StatusItem, StatusKey } from '../../supabase/functions/_shared/telnyxLogic';

export interface TelnyxSetupResult {
  ok: boolean;
  created: string[];
  reused: string[];
  updated: string[];
  config: {
    voiceAppId: string;
    voiceAppName: string;
    credentialConnectionId: string;
    credentialConnectionName: string;
    outboundVoiceProfileId: string;
    outboundVoiceProfileName: string;
    webhookUrl: string;
    publicKeyStored: boolean;
  };
  warnings: string[];
}

export interface TelnyxStatusResult {
  ok: boolean;
  checkedAt: string;
  items: StatusItem[];
  numbers: { dialer: number; inUseElsewhere: number; unassigned: number } | null;
  concurrentCallLimit: number | null;
  concurrentCallLimitSource: 'outbound_voice_profile' | 'unknown';
  concurrentCallLimitNote: string;
}

export interface TelnyxSyncResult {
  imported: number;
  updated: number;
  deactivated: number;
  dialer: { number: string; providerId: string }[];
  inUseElsewhere: { number: string; providerId: string; connectionId: string; connectionName: string | null }[];
  unassigned: { number: string; providerId: string }[];
}

export interface TelnyxAssignResult {
  number: string;
  providerId: string;
  alreadyAssigned: boolean;
  phoneNumberId: string;
}

let backend: TelnyxBackend | null = null;
function fns(): TelnyxBackend {
  if (!backend) backend = createSupabaseTelnyxBackend();
  return backend;
}

/** (admin) Find-or-create the dialer's Telnyx resources. Safe to call repeatedly. */
export function runTelnyxSetup(): Promise<TelnyxSetupResult> {
  return fns().invoke<TelnyxSetupResult>('telnyx-setup', {});
}

/** (admin) Read-only checklist. */
export function getTelnyxStatus(): Promise<TelnyxStatusResult> {
  return fns().invoke<TelnyxStatusResult>('telnyx-status', {});
}

/** (admin) Import the numbers attached to the dialer's voice app; reports the rest. */
export function syncTelnyxNumbers(): Promise<TelnyxSyncResult> {
  return fns().invoke<TelnyxSyncResult>('telnyx-sync-numbers', {});
}

/**
 * (admin) Attach one UNASSIGNED number to the dialer. Rejects when the number is used by another
 * app (the UI must not offer a force option).
 */
export function assignTelnyxNumber(providerId: string): Promise<TelnyxAssignResult> {
  return fns().invoke<TelnyxAssignResult>('telnyx-assign-number', { providerId });
}

/** True for CallRecord.recordingUrl values that need resolveRecordingUrl() before playback. */
export function isTelnyxRecordingRef(url: string | null | undefined): boolean {
  return parseRecordingRef(url) !== null;
}

/**
 * Playable URL for a CallRecord's recording: plain URLs are returned as is; Telnyx references are
 * exchanged for a fresh, short-lived download URL (call right before playing; do not cache).
 */
export async function resolveRecordingUrl(callRecordId: string, recordingUrl: string | null): Promise<string | null> {
  if (!recordingUrl) return null;
  if (!isTelnyxRecordingRef(recordingUrl)) return recordingUrl;
  const res = await fns().invoke<{ url: string }>('telnyx-recording', { callRecordId });
  return res.url;
}
