/** Pure helpers for recording playback (no React, no network). */

/** Mirrors parseRecordingRef in supabase/functions/_shared/telnyxLogic.ts. */
export function isRecordingRef(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.startsWith('telnyx-recording:');
}

/** Plain text for a failed telnyx-recording call. */
export function recordingErrorText(message: string): string {
  if (/Failed to send a request|Relay Error|non-2xx|Failed to fetch|NetworkError|fetch failed/i.test(message)) {
    return "Couldn't reach the server to get this recording.";
  }
  if (/no Telnyx recording|no downloadable file/i.test(message)) return 'Telnyx has no audio file for this call.';
  if (/Call not found/i.test(message)) return 'This call no longer exists.';
  if (/Not your call|Only an admin/i.test(message)) return "You don't have access to this recording.";
  if (/Telnyx rejected the API key/i.test(message)) return "Couldn't get the recording: Telnyx didn't accept the API key. See Numbers > Phone setup.";
  if (/TELNYX_API_KEY/i.test(message)) return "Couldn't get the recording: Telnyx isn't connected. See Numbers > Phone setup.";
  if (/session has expired|Not signed in/i.test(message)) return 'Your session has expired. Sign in again.';
  return `Couldn't load the recording: ${message}`;
}
