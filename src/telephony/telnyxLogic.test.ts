import { describe, expect, it } from 'vitest';
import {
  agentSessionIdOf,
  AGENT_SESSION_HEADER,
  base64ToBytes,
  agentBridgeBody,
  amdOutcome,
  buildDialBody,
  isInvalidDestination,
  screeningIntroSpeakBody,
  screeningIntroText,
  buildRingBody,
  derivedId,
  INBOUND_FIRST_OFFER_SECONDS,
  INBOUND_TOTAL_RING_SECONDS,
  MISSED_CALLBACK_SPEECH,
  missedCallbackSpeakBody,
  nextInboundStep,
  offerFor,
  offerIdFor,
  offerIdOfSdkCall,
  offerTag,
  othersRingSeconds,
  parentOfOfferTag,
  planInboundRouting,
  ringSessionIdFor,
  type InboundCandidate,
  clampRingSeconds,
  classifyNumbers,
  decodeClientState,
  encodeClientState,
  evaluateStatus,
  hangupToEndReason,
  isFreshTimestamp,
  isMachineEvent,
  isUsE164,
  normalizeTelnyxNumber,
  parseRecordingRef,
  parseSipCode,
  parseWebhook,
  rawEd25519PublicKey,
  recordingRef,
  signedMessage,
  type EndReason as LogicEndReason,
  type HangupContext,
  type StatusFacts,
} from '../../supabase/functions/_shared/telnyxLogic';
import type { EndReason } from './Telephony';

// Compile-time: the logic file's EndReason must equal the contract's.
const _sameEndReason: [LogicEndReason] extends [EndReason] ? ([EndReason] extends [LogicEndReason] ? true : never) : never = true;
void _sameEndReason;

const ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

describe('client_state', () => {
  it('round-trips each kind', () => {
    for (const s of [
      { v: 1, k: 'out', id: ID },
      { v: 1, k: 'in', id: ID },
      { v: 1, k: 'in', id: ID, st: 'bridge' },
      { v: 1, k: 'in', id: ID, st: 'polite' },
      { v: 1, k: 'agent', sid: ID },
      { v: 1, k: 'ring', id: ID, p: ID },
    ] as const) {
      const enc = encodeClientState(s);
      expect(enc).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(decodeClientState(enc)).toEqual(s);
    }
  });

  it('rejects foreign or malformed states', () => {
    expect(decodeClientState(undefined)).toBeNull();
    expect(decodeClientState('')).toBeNull();
    expect(decodeClientState('not base64 !!')).toBeNull();
    expect(decodeClientState(btoa('hello'))).toBeNull();
    expect(decodeClientState(btoa(JSON.stringify({ v: 2, k: 'out', id: ID })))).toBeNull();
    expect(decodeClientState(btoa(JSON.stringify({ v: 1, k: 'out' })))).toBeNull();
    expect(decodeClientState(btoa(JSON.stringify({ v: 1, k: 'out', id: "x'; drop" })))).toBeNull();
    expect(decodeClientState(btoa(JSON.stringify({ v: 1, k: 'in', id: ID, st: 'weird' })))).toBeNull();
    expect(decodeClientState(btoa(JSON.stringify({ v: 1, k: 'other', id: ID })))).toBeNull();
    expect(decodeClientState(btoa(JSON.stringify({ v: 1, k: 'ring', id: ID })))).toBeNull();
    // Telnyx docs' example client_state ("have a nice day") is not ours.
    expect(decodeClientState('aGF2ZSBhIG5pY2UgZGF5ID1d')).toBeNull();
  });

  it('drops unknown fields', () => {
    const raw = btoa(JSON.stringify({ v: 1, k: 'out', id: ID, extra: 'x' }));
    expect(decodeClientState(raw)).toEqual({ v: 1, k: 'out', id: ID });
  });
});

describe('numbers', () => {
  it('validates US E.164', () => {
    expect(isUsE164('+12145550123')).toBe(true);
    expect(isUsE164('+19452292188')).toBe(true);
    expect(isUsE164('2145550123')).toBe(false);
    expect(isUsE164('+1214555012')).toBe(false);
    expect(isUsE164('+11145550123')).toBe(false); // area code cannot start with 1
    expect(isUsE164('+12141550123')).toBe(false); // exchange cannot start with 1
    expect(isUsE164('+442071234567')).toBe(false);
    expect(isUsE164(12145550123)).toBe(false);
  });

  it('normalises Telnyx from/to values', () => {
    expect(normalizeTelnyxNumber('+12145550123')).toBe('+12145550123');
    expect(normalizeTelnyxNumber('12145550123')).toBe('+12145550123');
    expect(normalizeTelnyxNumber('2145550123')).toBe('+12145550123');
    expect(normalizeTelnyxNumber('sip:+12145550123@sip.telnyx.com')).toBe('+12145550123');
    expect(normalizeTelnyxNumber('sip:gencred123@sip.telnyx.com')).toBeNull();
    expect(normalizeTelnyxNumber(null)).toBeNull();
  });

  it('classifies numbers by attachment without ever importing others', () => {
    const c = classifyNumbers(
      [
        { id: 'n1', phone_number: '+12145550001', status: 'active', connection_id: 'app-ours' },
        { id: 'n2', phone_number: '+19452292188', status: 'active', connection_id: 'vapi-app', connection_name: 'Vapi' },
        { id: 'n3', phone_number: '+12145550003', status: 'active', connection_id: null },
        { id: 'n4', phone_number: '+12145550004', status: 'purchase-pending', connection_id: null },
      ],
      'app-ours',
    );
    expect(c.dialer).toEqual([{ number: '+12145550001', providerId: 'n1' }]);
    expect(c.inUseElsewhere).toEqual([
      { number: '+19452292188', providerId: 'n2', connectionId: 'vapi-app', connectionName: 'Vapi' },
    ]);
    expect(c.unassigned).toEqual([{ number: '+12145550003', providerId: 'n3' }]);
  });

  it('treats every attached number as elsewhere when the dialer app is not set up', () => {
    const c = classifyNumbers([{ id: 'n1', phone_number: '+12145550001', connection_id: 'x' }], null);
    expect(c.dialer).toEqual([]);
    expect(c.inUseElsewhere).toHaveLength(1);
  });
});

describe('hangupToEndReason', () => {
  const base: HangupContext = {
    direction: 'outbound',
    answered: false,
    localRequested: false,
    cause: null,
    source: null,
    sipCode: null,
  };
  const r = (p: Partial<HangupContext>) => hangupToEndReason({ ...base, ...p });

  it('outbound, never answered', () => {
    expect(r({ cause: 'timeout' })).toBe('no_answer');
    expect(r({ cause: 'no_answer' })).toBe('no_answer');
    expect(r({ cause: 'user_busy', sipCode: 486 })).toBe('busy');
    expect(r({ cause: 'normal_clearing', sipCode: 486 })).toBe('busy');
    expect(r({ cause: 'unspecified', sipCode: 600 })).toBe('busy');
    expect(r({ cause: 'not_found', sipCode: 404 })).toBe('bad_number');
    expect(r({ cause: 'unspecified', sipCode: 404 })).toBe('bad_number');
    expect(r({ cause: 'unspecified', sipCode: 410 })).toBe('bad_number');
    expect(r({ cause: 'unspecified', sipCode: 484 })).toBe('bad_number');
    expect(r({ cause: 'unspecified', sipCode: 604 })).toBe('bad_number');
    expect(r({ cause: 'call_rejected', sipCode: 603 })).toBe('no_answer');
    expect(r({ cause: 'unspecified', sipCode: 480 })).toBe('no_answer');
    expect(r({ cause: 'unspecified', sipCode: 503 })).toBe('failed');
    expect(r({ cause: 'unspecified' })).toBe('failed');
    expect(r({ cause: 'normal_clearing' })).toBe('failed');
    expect(r({})).toBe('failed');
  });

  it('local hangup always wins', () => {
    expect(r({ localRequested: true, cause: 'timeout' })).toBe('hangup_local');
    expect(r({ localRequested: true, answered: true, source: 'callee' })).toBe('hangup_local');
    expect(r({ localRequested: true, direction: 'inbound' })).toBe('hangup_local');
  });

  it('outbound answered: who hung up', () => {
    expect(r({ answered: true, cause: 'normal_clearing', source: 'callee' })).toBe('hangup_remote');
    expect(r({ answered: true, cause: 'normal_clearing', source: 'caller' })).toBe('hangup_local');
    expect(r({ answered: true, cause: 'normal_clearing', source: 'unknown' })).toBe('hangup_remote');
    expect(r({ answered: true, cause: 'time_limit', source: 'callee' })).toBe('hangup_local');
  });

  it('inbound: the lead is the caller', () => {
    expect(r({ direction: 'inbound', answered: true, source: 'caller' })).toBe('hangup_remote');
    expect(r({ direction: 'inbound', answered: true, source: 'callee' })).toBe('hangup_local');
    expect(r({ direction: 'inbound', answered: false, source: 'caller', cause: 'normal_clearing' })).toBe('hangup_remote');
    expect(r({ direction: 'inbound', answered: false, cause: 'originator_cancel' })).toBe('hangup_remote');
    expect(r({ direction: 'inbound', answered: false, cause: 'timeout' })).toBe('no_answer');
    expect(r({ direction: 'inbound', answered: false, source: 'callee', cause: 'normal_clearing' })).toBe('no_answer');
  });

  it('parses sip codes', () => {
    expect(parseSipCode('486')).toBe(486);
    expect(parseSipCode(404)).toBe(404);
    expect(parseSipCode('unspecified')).toBeNull();
    expect(parseSipCode('16')).toBeNull(); // Q.850 cause in a docs example, not a SIP code
    expect(parseSipCode(undefined)).toBeNull();
  });
});

describe('machine detection', () => {
  it('maps standard and premium results', () => {
    expect(isMachineEvent('call.machine.detection.ended', 'machine')).toBe(true);
    expect(isMachineEvent('call.machine.detection.ended', 'human')).toBe(false);
    expect(isMachineEvent('call.machine.detection.ended', 'not_sure')).toBe(false);
    expect(isMachineEvent('call.machine.premium.detection.ended', 'machine')).toBe(true);
    expect(isMachineEvent('call.machine.premium.detection.ended', 'fax_detected')).toBe(true);
    expect(isMachineEvent('call.machine.premium.detection.ended', 'human_business')).toBe(false);
    expect(isMachineEvent('call.machine.premium.detection.ended', 'human_residence')).toBe(false);
    expect(isMachineEvent('call.machine.premium.detection.ended', 'silence')).toBe(false);
    expect(isMachineEvent('call.machine.premium.call_screening.detected', 'screening')).toBe(true);
    expect(isMachineEvent('call.machine.greeting.ended', 'beep_detected')).toBe(false);
    expect(isMachineEvent('call.machine.premium.greeting.ended', 'beep_detected')).toBe(false);
  });
});

function envelope(eventType: string, payload: Record<string, unknown>, id = 'evt-1') {
  return { data: { record_type: 'event', event_type: eventType, id, occurred_at: '2026-11-15T10:00:00.000Z', payload }, meta: {} };
}

describe('parseWebhook', () => {
  it('parses call.hangup (OpenAPI example shape)', () => {
    const w = parseWebhook(
      envelope('call.hangup', {
        call_control_id: 'v3:abc',
        connection_id: '7267',
        call_leg_id: 'leg-1',
        call_session_id: 'sess-1',
        client_state: encodeClientState({ v: 1, k: 'out', id: ID }),
        from: '+12145550001',
        to: '+12145550002',
        state: 'hangup',
        hangup_cause: 'call_rejected',
        hangup_source: 'caller',
        sip_hangup_cause: '603',
      }),
    );
    expect(w).not.toBeNull();
    expect(w!.kind).toBe('hangup');
    expect(w!.eventId).toBe('evt-1');
    expect(w!.callControlId).toBe('v3:abc');
    expect(w!.clientState).toEqual({ v: 1, k: 'out', id: ID });
    expect(w!.hangup).toEqual({ cause: 'call_rejected', source: 'caller', sipCode: 603 });
  });

  it('parses call.initiated direction/state and custom headers', () => {
    const w = parseWebhook(
      envelope('call.initiated', {
        call_control_id: 'v3:agent',
        connection_id: 'cred-conn',
        direction: 'incoming',
        state: 'parked',
        from: 'gencredabc',
        to: 'quest-agent',
        custom_headers: [{ name: AGENT_SESSION_HEADER, value: ID }],
      }),
    )!;
    expect(w.kind).toBe('initiated');
    expect(w.direction).toBe('incoming');
    expect(w.state).toBe('parked');
    expect(w.clientState).toBeNull();
    expect(agentSessionIdOf(w)).toBe(ID);
  });

  it('prefers the agent client_state over the header', () => {
    const w = parseWebhook(
      envelope('call.initiated', {
        client_state: encodeClientState({ v: 1, k: 'agent', sid: ID }),
        custom_headers: [{ name: AGENT_SESSION_HEADER.toLowerCase(), value: 'other-id' }],
      }),
    )!;
    expect(agentSessionIdOf(w)).toBe(ID);
  });

  it('parses machine and recording events', () => {
    const m = parseWebhook(envelope('call.machine.premium.detection.ended', { result: 'machine' }))!;
    expect(m.kind).toBe('machine');
    expect(m.isMachine).toBe(true);
    expect(m.machineResult).toBe('machine');
    const h = parseWebhook(envelope('call.machine.premium.detection.ended', { result: 'human_business' }))!;
    expect(h.isMachine).toBe(false);
    const rec = parseWebhook(
      envelope('call.recording.saved', {
        call_leg_id: 'leg-1',
        recording_urls: { mp3: 'https://example.invalid/a.mp3', wav: null },
        channels: 'dual',
      }),
    )!;
    expect(rec.kind).toBe('recording_saved');
    expect(rec.recordingUrls).toEqual({ mp3: 'https://example.invalid/a.mp3', wav: null });
  });

  it('classifies other kinds and rejects non-envelopes', () => {
    expect(parseWebhook(envelope('call.answered', {}))!.kind).toBe('answered');
    expect(parseWebhook(envelope('call.bridged', {}))!.kind).toBe('bridged');
    expect(parseWebhook(envelope('call.speak.ended', {}))!.kind).toBe('speak_ended');
    expect(parseWebhook(envelope('call.dtmf.received', {}))!.kind).toBe('other');
    expect(parseWebhook(null)).toBeNull();
    expect(parseWebhook({})).toBeNull();
    expect(parseWebhook({ data: { event_type: 'call.hangup' } })).toBeNull(); // no id
    expect(parseWebhook({ event_type: 'call.hangup', payload: {} })).toBeNull(); // API v1 shape
  });
});

describe('webhook signature helpers', () => {
  it('builds the signed message as timestamp|body', () => {
    expect(signedMessage('1700000000', '{"a":1}')).toBe('1700000000|{"a":1}');
  });

  it('checks the replay window', () => {
    expect(isFreshTimestamp('1700000000', 1700000100)).toBe(true);
    expect(isFreshTimestamp('1700000000', 1700000301)).toBe(false);
    expect(isFreshTimestamp('1700000400', 1700000000)).toBe(false);
    expect(isFreshTimestamp(null, 1700000000)).toBe(false);
    expect(isFreshTimestamp('abc', 1700000000)).toBe(false);
  });

  it('verifies a signature the way telnyx-webhook does (WebCrypto Ed25519)', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const spkiPub = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    const body = JSON.stringify(envelope('call.answered', { call_control_id: 'v3:x' }));
    const ts = '1763200000';
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(signedMessage(ts, body))),
    );
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    for (const pubB64 of [b64(rawPub), b64(spkiPub)]) {
      const raw = rawEd25519PublicKey(base64ToBytes(pubB64)!)!;
      const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
      const sigBytes = base64ToBytes(b64(sig))!;
      const msg = (t: string, b: string) => new TextEncoder().encode(signedMessage(t, b));
      expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, sigBytes, msg(ts, body))).toBe(true);
      expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, sigBytes, msg(ts, body + ' '))).toBe(false);
      expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, sigBytes, msg('1763200001', body))).toBe(false);
    }
  });

  it('accepts raw and SPKI-encoded Ed25519 keys', () => {
    const raw = new Uint8Array(32).map((_, i) => i + 1);
    expect(rawEd25519PublicKey(raw)).toEqual(raw);
    const spki = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00, ...raw]);
    expect(rawEd25519PublicKey(spki)).toEqual(raw);
    expect(rawEd25519PublicKey(new Uint8Array(31))).toBeNull();
    expect(rawEd25519PublicKey(new Uint8Array(44))).toBeNull();
    expect(base64ToBytes(btoa('\x01\x02'))).toEqual(new Uint8Array([1, 2]));
    expect(base64ToBytes('***')).toBeNull();
  });
});

describe('recording references', () => {
  it('round-trips and rejects plain URLs', () => {
    const ref = recordingRef('428c31b6-7af4-4bcb-b7f5-5013ef9657c1');
    expect(ref).toBe('telnyx-recording:428c31b6-7af4-4bcb-b7f5-5013ef9657c1');
    expect(parseRecordingRef(ref)).toBe('428c31b6-7af4-4bcb-b7f5-5013ef9657c1');
    expect(parseRecordingRef('https://example.invalid/a.mp3')).toBeNull();
    expect(parseRecordingRef('data:audio/mp3;base64,AAA')).toBeNull();
    expect(parseRecordingRef(null)).toBeNull();
  });
});

describe('buildDialBody', () => {
  const input = {
    callId: ID,
    voiceAppId: 'app-1',
    to: '+12145550002',
    from: '+12145550001',
    ringSeconds: 22,
    detectMachine: true,
    record: true,
  };

  it('dials the lead without linking or auto-bridging (that hung up the agent leg after each call)', () => {
    const b = buildDialBody(input);
    expect(b).toMatchObject({
      connection_id: 'app-1',
      to: '+12145550002',
      from: '+12145550001',
      timeout_secs: 22,
      retry_on_timeout: false,
      command_id: ID,
      answering_machine_detection: 'premium',
      record: 'record-from-answer',
      record_channels: 'dual',
      record_format: 'mp3',
    });
    expect(decodeClientState(b.client_state)).toEqual({ v: 1, k: 'out', id: ID });
    // bridge_intent would overwrite `from` with the agent leg's from: never sent.
    expect(b).not.toHaveProperty('bridge_intent');
    expect(b).not.toHaveProperty('link_to');
    expect(b).not.toHaveProperty('bridge_on_answer');
    expect(b).not.toHaveProperty('park_after_unbridge');
  });

  it('uses the call-screening detection mode only when a screening intro is set', () => {
    expect(buildDialBody({ ...input, screeningIntro: true }).answering_machine_detection).toBe('premium_ios_call_screening_detection');
    expect(buildDialBody({ ...input, screeningIntro: false }).answering_machine_detection).toBe('premium');
  });

  it('agent bridge: issued from the agent leg, which is parked (not hung up) when the lead leaves', () => {
    expect(agentBridgeBody('v3:lead', ID)).toEqual({
      call_control_id: 'v3:lead',
      park_after_unbridge: 'self',
      command_id: `bridge-${ID}`,
    });
  });

  it('omits AMD and recording when not requested', () => {
    const b = buildDialBody({ ...input, detectMachine: false, record: false });
    expect(b).not.toHaveProperty('answering_machine_detection');
    expect(b).not.toHaveProperty('record');
  });

  it('clamps the ring time to Telnyx limits (5..600)', () => {
    expect(clampRingSeconds(2, 22)).toBe(5);
    expect(clampRingSeconds(1000, 22)).toBe(600);
    expect(clampRingSeconds(undefined, 22)).toBe(22);
    expect(clampRingSeconds(Number.NaN, 30)).toBe(30);
    expect(clampRingSeconds(21.6, 22)).toBe(22);
  });
});

describe('isInvalidDestination', () => {
  it('spots a refused number (D11) but not account or capacity errors', () => {
    expect(isInvalidDestination(['D11'], 'Destination Number is invalid')).toBe(true);
    expect(isInvalidDestination([''], 'Destination Number is invalid D11. The destination number is invalid.')).toBe(true);
    expect(isInvalidDestination(['D1'], 'User channel limit exceeded')).toBe(false);
    expect(isInvalidDestination(['10010'], 'Invalid connection')).toBe(false);
  });
});

describe('call screening', () => {
  it('tells voicemail, a possible screener, a finished screening prompt and a person apart', () => {
    expect(amdOutcome('call.machine.premium.detection.ended', 'machine')).toBe('suspect');
    expect(amdOutcome('call.machine.premium.detection.ended', 'fax_detected')).toBe('voicemail');
    expect(amdOutcome('call.machine.premium.detection.ended', 'human_residence')).toBeNull();
    expect(amdOutcome('call.machine.premium.detection.ended', 'human_business')).toBeNull();
    expect(amdOutcome('call.machine.premium.greeting.ended', 'prompt_ended')).toBe('screening');
    expect(amdOutcome('call.machine.premium.greeting.ended', 'beep_detected')).toBe('voicemail');
    expect(amdOutcome('call.machine.premium.greeting.ended', 'no_beep_detected')).toBe('voicemail');
    expect(amdOutcome('call.machine.premium.call_screening.detected', 'screening')).toBe('screening');
    expect(amdOutcome('call.machine.detection.ended', 'machine')).toBe('voicemail');
    expect(amdOutcome('call.machine.premium.detection.started', undefined)).toBeNull();
  });

  it('fills in the caller first name, or drops it cleanly when unknown', () => {
    const t = 'Hi, this is {name} with Quest Labs, calling for the business owner.';
    expect(screeningIntroText(t, 'Mahavir Sopppannavar')).toBe('Hi, this is Mahavir with Quest Labs, calling for the business owner.');
    expect(screeningIntroText(t, null)).toBe('Hi, this is Quest Labs, calling for the business owner.');
    expect(screeningIntroText('Calling for the owner.', 'Sam')).toBe('Calling for the owner.');
    const li = 'Hi, this is {name}. Saw your LinkedIn post, interested in connecting.';
    expect(screeningIntroText(li, 'Mahavir Sopppannavar')).toBe('Hi, this is Mahavir. Saw your LinkedIn post, interested in connecting.');
  });

  it('speaks once per call on the lead leg, with a fallback voice', () => {
    const b = screeningIntroSpeakBody('Hello', ID);
    expect(b).toMatchObject({ payload: 'Hello', payload_type: 'text', voice: 'Azure.en-US-Ava:DragonHDLatestNeural', command_id: `intro-${ID}` });
    expect(decodeClientState(b.client_state)).toEqual({ v: 1, k: 'out', id: ID });
    expect(screeningIntroSpeakBody('Hello', ID, true)).toMatchObject({ voice: 'AWS.Polly.Joanna-Neural', command_id: `intro-${ID}-b` });
  });
});

describe('evaluateStatus', () => {
  const hook = 'https://proj.supabase.co/functions/v1/telnyx-webhook';
  const good: StatusFacts = {
    apiKeyPresent: true,
    apiKeyAccepted: true,
    expectedWebhookUrl: hook,
    voiceApp: { id: 'a', name: 'Quest Labs Dialer - Voice App', webhookUrl: hook, apiVersion: '2', profileId: 'p' },
    credentialConnection: { id: 'c', name: 'Quest Labs Dialer - WebRTC', webhookUrl: hook, apiVersion: '2', parking: true, profileId: 'p' },
    outboundProfile: { id: 'p', name: 'Quest Labs - US Outbound' },
    publicKeyPresent: true,
    dialerNumbers: 2,
  };

  it('all ok for a complete setup', () => {
    const items = evaluateStatus(good);
    expect(items.every((i) => i.ok)).toBe(true);
    expect(items.every((i) => i.hint === null)).toBe(true);
    expect(items.map((i) => i.key)).toContain('numbers');
  });

  it('stops after a missing API key with a hint', () => {
    const items = evaluateStatus({ ...good, apiKeyPresent: false, apiKeyAccepted: false });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'api_key', ok: false });
    expect(items[0].hint).toMatch(/TELNYX_API_KEY/);
  });

  it('flags a wrong webhook, missing parking and no numbers', () => {
    const items = evaluateStatus({
      ...good,
      voiceApp: { ...good.voiceApp!, webhookUrl: 'https://api.vapi.ai/x' },
      credentialConnection: { ...good.credentialConnection!, parking: false },
      dialerNumbers: 0,
    });
    const bad = items.filter((i) => !i.ok).map((i) => i.key);
    expect(bad).toEqual(['voice_app_webhook', 'webrtc_parking', 'numbers']);
    for (const i of items.filter((x) => !x.ok)) expect(i.hint).toBeTruthy();
  });

  it('flags callbacks that cannot ring the app (SIP URI calling off) only when reported', () => {
    const off = evaluateStatus({ ...good, credentialConnection: { ...good.credentialConnection!, sipUriCalling: 'disabled' } });
    expect(off.filter((i) => !i.ok).map((i) => i.key)).toEqual(['webrtc_inbound']);
    const on = evaluateStatus({ ...good, credentialConnection: { ...good.credentialConnection!, sipUriCalling: 'internal' } });
    expect(on.find((i) => i.key === 'webrtc_inbound')!.ok).toBe(true);
    expect(evaluateStatus(good).some((i) => i.key === 'webrtc_inbound')).toBe(false);
  });

  it('reports missing resources', () => {
    const items = evaluateStatus({ ...good, voiceApp: null, credentialConnection: null, publicKeyPresent: false });
    const bad = items.filter((i) => !i.ok).map((i) => i.key);
    expect(bad).toEqual(['voice_app', 'webrtc_connection', 'webhook_public_key']);
  });
});

describe('inbound ids and tags', () => {
  const P = '11111111-2222-4333-8444-555555555555';
  it('derives stable, uuid-shaped, distinct ids', () => {
    const a = offerIdFor(P, 'caller-a');
    expect(a).toBe(offerIdFor(P, 'caller-a'));
    expect(a).not.toBe(offerIdFor(P, 'caller-b'));
    expect(a).not.toBe(offerIdFor(ID, 'caller-a'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ringSessionIdFor(a)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ringSessionIdFor(a)).not.toBe(a);
    const many = new Set(Array.from({ length: 2000 }, (_, i) => derivedId('x', String(i))));
    expect(many.size).toBe(2000);
  });

  it('links an offer to its parent through call_session_id', () => {
    expect(parentOfOfferTag(offerTag(P))).toBe(P);
    expect(parentOfOfferTag('v3:telnyx-session')).toBeNull();
    expect(parentOfOfferTag(null)).toBeNull();
    expect(parentOfOfferTag("offer:x'; drop")).toBeNull();
  });

  it('reads the offer id of an SDK call from the header or the client_state', () => {
    expect(offerIdOfSdkCall({ customHeaders: [{ name: 'x-quest-offer', value: ID }] })).toBe(ID);
    expect(offerIdOfSdkCall({ clientState: encodeClientState({ v: 1, k: 'ring', id: ID, p: P }) })).toBe(ID);
    expect(offerIdOfSdkCall({ clientState: encodeClientState({ v: 1, k: 'agent', sid: ID }) })).toBeNull();
    expect(offerIdOfSdkCall({ customHeaders: [{ name: 'X-Quest-Offer', value: 'bad value!' }] })).toBeNull();
    expect(offerIdOfSdkCall(undefined)).toBeNull();
  });
});

describe('inbound routing', () => {
  const P = '11111111-2222-4333-8444-555555555555';
  const NOW = Date.parse('2026-11-15T15:00:00Z');
  const fresh = new Date(NOW - 20_000).toISOString();
  const stale = new Date(NOW - 120_000).toISOString();
  const cand = (p: Partial<InboundCandidate> & { callerId: string }): InboundCandidate => ({
    presence: 'idle',
    presenceUpdatedAt: fresh,
    liveAgentSessionId: null,
    sipUsername: `gencred${p.callerId}`,
    busy: false,
    ...p,
  });

  it('who can take a call, and how it reaches them', () => {
    expect(offerFor(cand({ callerId: 'a' }), NOW)).toEqual({ callerId: 'a', via: 'sip', sipUsername: 'gencreda' });
    expect(offerFor(cand({ callerId: 'a', presence: 'paused', liveAgentSessionId: 's1' }), NOW)).toEqual({
      callerId: 'a',
      via: 'agent_leg',
      agentSessionId: 's1',
    });
    expect(offerFor(cand({ callerId: 'a', presence: 'dialing', liveAgentSessionId: 's1' }), NOW)?.via).toBe('agent_leg');
    // Not signed in / app closed (stale heartbeat), on a call, wrapping up, busy, never logged in to calling.
    expect(offerFor(cand({ callerId: 'a', presence: 'offline' }), NOW)).toBeNull();
    expect(offerFor(cand({ callerId: 'a', presence: null, presenceUpdatedAt: null }), NOW)).toBeNull();
    expect(offerFor(cand({ callerId: 'a', presenceUpdatedAt: stale }), NOW)).toBeNull();
    expect(offerFor(cand({ callerId: 'a', presence: 'on_call' }), NOW)).toBeNull();
    expect(offerFor(cand({ callerId: 'a', presence: 'wrap_up' }), NOW)).toBeNull();
    expect(offerFor(cand({ callerId: 'a', busy: true }), NOW)).toBeNull();
    expect(offerFor(cand({ callerId: 'a', sipUsername: null }), NOW)).toBeNull();
  });

  it('the last caller of the number gets it first, alone; everyone else free is the second round', () => {
    const plan = planInboundRouting({
      preferredCallerId: 'b',
      nowMs: NOW,
      candidates: [cand({ callerId: 'c' }), cand({ callerId: 'b' }), cand({ callerId: 'a', presence: 'on_call' }), cand({ callerId: 'd', presence: 'dialing', liveAgentSessionId: 's' })],
    });
    expect(plan.first.map((o) => o.callerId)).toEqual(['b']);
    expect(plan.others.map((o) => o.callerId)).toEqual(['c', 'd']);
  });

  it('skips straight to everyone else when the last caller cannot take it or is unknown', () => {
    const busy = planInboundRouting({
      preferredCallerId: 'b',
      nowMs: NOW,
      candidates: [cand({ callerId: 'b', presence: 'wrap_up' }), cand({ callerId: 'c' })],
    });
    expect(busy.first).toEqual([]);
    expect(busy.others.map((o) => o.callerId)).toEqual(['c']);
    const unknown = planInboundRouting({ preferredCallerId: null, nowMs: NOW, candidates: [cand({ callerId: 'c' })] });
    expect(unknown.first).toEqual([]);
    expect(unknown.others.map((o) => o.callerId)).toEqual(['c']);
    const nobody = planInboundRouting({ preferredCallerId: 'b', nowMs: NOW, candidates: [cand({ callerId: 'b', presence: 'offline' })] });
    expect(nobody).toEqual({ first: [], others: [] });
  });

  it('never offers the same caller twice', () => {
    const plan = planInboundRouting({
      preferredCallerId: 'b',
      nowMs: NOW,
      candidates: [cand({ callerId: 'b' }), cand({ callerId: 'c' }), cand({ callerId: 'c' })],
      alreadyOffered: new Set(['b']),
    });
    expect(plan.first).toEqual([]);
    expect(plan.others.map((o) => o.callerId)).toEqual(['c']);
  });

  it('next step: wait while ringing, then everyone else, then the missed-call message', () => {
    expect(INBOUND_FIRST_OFFER_SECONDS).toBe(15);
    expect(INBOUND_TOTAL_RING_SECONDS).toBe(30);
    expect(nextInboundStep({ elapsedMs: 3_000, othersOffered: false, ringingOffers: 1 })).toBe('wait');
    expect(nextInboundStep({ elapsedMs: 15_000, othersOffered: false, ringingOffers: 0 })).toBe('offer_others');
    // The last caller declined at once: the others get it straight away.
    expect(nextInboundStep({ elapsedMs: 2_000, othersOffered: false, ringingOffers: 0 })).toBe('offer_others');
    expect(nextInboundStep({ elapsedMs: 20_000, othersOffered: true, ringingOffers: 0 })).toBe('fallback');
    expect(nextInboundStep({ elapsedMs: 27_000, othersOffered: false, ringingOffers: 0 })).toBe('fallback');
    expect(othersRingSeconds(15_000)).toBe(15);
    expect(othersRingSeconds(2_000)).toBe(28);
    expect(othersRingSeconds(29_000)).toBe(5);
  });

  it('ring body: dials the caller app by SIP URI from our number, with the offer in header and client_state', () => {
    const body = buildRingBody({ voiceAppId: 'app', sipUsername: 'gencredABC', from: '+12145550001', offerId: ID, parentId: P, ringSeconds: 15 });
    expect(body).toMatchObject({
      connection_id: 'app',
      to: 'sip:gencredABC@sip.telnyx.com',
      from: '+12145550001',
      timeout_secs: 15,
      custom_headers: [{ name: 'X-Quest-Offer', value: ID }],
      command_id: `ring-${ID}`,
    });
    expect(decodeClientState(body.client_state)).toEqual({ v: 1, k: 'ring', id: ID, p: P });
    // Never bridged automatically, never recorded on its own.
    expect(body).not.toHaveProperty('link_to');
    expect(body).not.toHaveProperty('record');
  });

  it('missed-call message: one constant, natural voice with a standard fallback', () => {
    expect(MISSED_CALLBACK_SPEECH.text).toBe("Thanks for calling back. Sorry we missed you. We'll try you again shortly.");
    const cs = encodeClientState({ v: 1, k: 'in', id: P, st: 'polite' });
    expect(missedCallbackSpeakBody(cs)).toEqual({
      payload: MISSED_CALLBACK_SPEECH.text,
      payload_type: 'text',
      voice: 'Azure.en-US-Ava:DragonHDLatestNeural',
      language: 'en-US',
      client_state: cs,
    });
    expect(missedCallbackSpeakBody(cs, true).voice).toBe('AWS.Polly.Joanna-Neural');
  });
});
