import { describe, expect, it } from 'vitest';
import { parseRecordingRef, recordingRef } from '../../../../supabase/functions/_shared/telnyxLogic';
import { isRecordingRef, recordingErrorText } from './recordingRef';

describe('isRecordingRef', () => {
  it('matches the stored Telnyx reference, not plain URLs', () => {
    expect(isRecordingRef(recordingRef('abc-123'))).toBe(true);
    expect(isRecordingRef('https://example.com/a.mp3')).toBe(false);
    expect(isRecordingRef('/demo/rec.mp3')).toBe(false);
    expect(isRecordingRef(null)).toBe(false);
    expect(isRecordingRef(undefined)).toBe(false);
  });
  it('agrees with the server parser for valid ids', () => {
    for (const id of ['a', 'v3-0f9c', 'X'.repeat(64)]) {
      expect(isRecordingRef(recordingRef(id))).toBe(parseRecordingRef(recordingRef(id)) !== null);
    }
  });
});

describe('recordingErrorText', () => {
  it('explains common failures in plain words', () => {
    expect(recordingErrorText('Failed to send a request to the Edge Function')).toMatch(/reach the server/);
    expect(recordingErrorText('This call has no Telnyx recording.')).toBe('Telnyx has no audio file for this call.');
    expect(recordingErrorText('Telnyx has no downloadable file for this recording.')).toBe('Telnyx has no audio file for this call.');
    expect(recordingErrorText('Not your call.')).toMatch(/access/);
    expect(recordingErrorText('Telnyx rejected the API key.')).toMatch(/Phone setup/);
    expect(recordingErrorText('weird')).toBe("Couldn't load the recording: weird");
  });
});
