// telnyx-recording: returns a fresh download URL for a recorded call.
// Body: { callRecordId: string }  (calls.id). Admins: any call. Callers: only their own calls.
// calls.recording_url holds 'telnyx-recording:<recording id>' because the URLs in
// call.recording.saved expire after 10 minutes; GET /v2/recordings/{id} returns current download_urls.
// Response (200): { url: string, format: 'mp3' | 'wav', durationMs: number | null }
import { parseRecordingRef } from '../_shared/telnyxLogic.ts';
import { adminClient, HttpError, json, readJson, requireUser, serve, telnyx } from '../_shared/telnyx.ts';

serve(async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ callRecordId?: string }>(req);
  if (typeof body.callRecordId !== 'string' || !body.callRecordId) throw new HttpError(400, 'callRecordId is required.', 'invalid');

  const { data: call } = await adminClient()
    .from('calls')
    .select('id, caller_id, recording_url')
    .eq('id', body.callRecordId)
    .maybeSingle();
  if (!call) throw new HttpError(404, 'Call not found.', 'not_found');
  if (user.role !== 'admin' && call.caller_id !== user.id) throw new HttpError(403, 'Not your call.', 'permission_denied');

  const recordingId = parseRecordingRef(call.recording_url);
  if (!recordingId) throw new HttpError(404, 'This call has no Telnyx recording.', 'not_found');

  const res = await telnyx<{ data: { download_urls?: { mp3?: string; wav?: string }; duration_millis?: number } }>(
    'GET',
    `/recordings/${encodeURIComponent(recordingId)}`,
  );
  const urls = res.data?.download_urls ?? {};
  const url = urls.mp3 ?? urls.wav;
  if (!url) throw new HttpError(404, 'Telnyx has no downloadable file for this recording.', 'not_found');
  return json({ url, format: urls.mp3 ? 'mp3' : 'wav', durationMs: res.data?.duration_millis ?? null });
});
