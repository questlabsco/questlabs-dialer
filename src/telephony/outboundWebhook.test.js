import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ command: vi.fn(), emit: vi.fn(), db: vi.fn() }));
vi.mock('../../supabase/functions/_shared/telnyx.ts', () => ({
  adminClient: calls.db,
  callCommand: calls.command,
  emitEvent: calls.emit,
  env: vi.fn(),
  loadConfig: vi.fn(),
  loadSettings: vi.fn(),
  telnyx: vi.fn(),
}));
vi.mock('../../supabase/functions/_shared/telnyxInbound.ts', () => ({}));
let handle;
beforeAll(async () => {
  vi.stubGlobal('Deno', { serve: vi.fn() });
  handle = (await import('../../supabase/functions/telnyx-webhook/index.ts')).handleOutbound;
});
afterAll(() => vi.unstubAllGlobals());
const row = {
  id: 'lead-call',
  caller_id: 'caller',
  call_control_id: 'pstn',
  direction: 'outbound',
  classify: true,
  has_screening: true,
  has_voicemail: true,
  wait_for_greeting: true,
  status: 'ringing',
};
const event = (machineResult, eventType) => ({ kind: 'machine', machineResult, eventType });
beforeEach(() => {
  vi.clearAllMocks();
  const update = {
    update: () => update,
    eq: () => update,
    in: () => update,
    is: () => update,
    or: () => update,
    select: async () => ({ data: [{ id: row.id }] }),
  };
  calls.db.mockReturnValue({
    from: () => update,
    storage: { from: () => ({ createSignedUrl: async (path) => ({ data: { signedUrl: path } }) }) },
    rpc: async () => ({ data: { result: 'won', agent_call_control_id: 'agent' } }),
  });
});
describe('outbound call routing', () => {
  it('waits through pickup and the screening tone, then plays the introduction at the end of the prompt', async () => {
    await handle({ kind: 'answered' }, row);
    await handle(event('machine', 'call.machine.premium.detection.ended'), row);
    await handle(event('screening', 'call.machine.premium.call_screening.detected'), row);
    expect(calls.command).not.toHaveBeenCalled();
    await handle(event('prompt_ended', 'call.machine.premium.greeting.ended'), row);
    expect(calls.command).toHaveBeenCalledWith(
      'pstn',
      'playback_start',
      expect.objectContaining({ audio_url: 'caller/screening.wav' }),
    );
    await handle(event('human_residence', 'call.machine.premium.detection.ended'), row);
    expect(calls.command).toHaveBeenCalledWith('agent', 'bridge', expect.anything(), false);
    expect(calls.emit.mock.calls.flat().some((e) => e.type === 'answered')).toBe(false);
    await handle({ kind: 'bridged' }, { ...row, status: 'answered' });
    expect(calls.emit).toHaveBeenCalledWith({ callerId: 'caller', callId: 'lead-call', type: 'answered' });
  });
  it('plays voicemail at the beep and hangs up only after the voicemail playback completes', async () => {
    await handle(event('beep_detected', 'call.machine.premium.greeting.ended'), row);
    expect(calls.command).toHaveBeenCalledWith(
      'pstn',
      'playback_start',
      expect.objectContaining({ audio_url: 'caller/voicemail.wav' }),
    );
    const ended = { eventType: 'call.playback.ended', callControlId: 'pstn', kind: 'other' };
    await handle({ ...ended, clientState: { k: 'out', playback: 'screening' } }, { ...row, media_phase: 'voicemail' });
    expect(calls.command).toHaveBeenCalledTimes(1);
    await handle({ ...ended, clientState: { k: 'out', playback: 'voicemail' } }, { ...row, media_phase: 'voicemail' });
    expect(calls.command).toHaveBeenLastCalledWith('pstn', 'hangup', expect.anything());
  });
});
