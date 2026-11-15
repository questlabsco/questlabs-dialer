/**
 * React access to the single app-wide DialerEngine:
 * `const { state, controls } = useDialer();`
 * The engine outlives screen changes, so a call continues if the caller switches tabs.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { api } from '../api';
import { telephony } from '../telephony';
import { DialerEngine } from './engine';
import type { DialerControls, DialerState } from './types';

let engine: DialerEngine | null = null;

/**
 * The shared engine instance (created lazily, the first time a caller's screen needs it, i.e. right
 * after a caller signs in). It puts the caller on standby so people calling back can reach them
 * while they are not dialing.
 */
export function getDialerEngine(): DialerEngine {
  // While signing out, screens still rendering keep the engine being disposed (instead of starting
  // a fresh one that would go back on standby for the user who is leaving).
  if (!engine && disposing) return disposing;
  if (!engine) engine = new DialerEngine({ api, telephony, standby: true });
  return engine;
}

let disposing: DialerEngine | null = null;

/** Stops and discards the shared engine (call on sign-out): hangs up, releases locks, ends standby. */
export async function resetDialerEngine(): Promise<void> {
  if (engine) {
    const e = engine;
    engine = null;
    disposing = e;
    try {
      await e.dispose();
    } finally {
      if (disposing === e) disposing = null;
    }
  }
}

export function useDialer(): { state: DialerState; controls: DialerControls } {
  const e = getDialerEngine();
  const subscribe = useCallback((cb: () => void) => e.subscribe(cb), [e]);
  const getSnapshot = useCallback(() => e.getState(), [e]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const controls = useMemo<DialerControls>(
    () => ({
      start: () => e.start(),
      pause: () => e.pause(),
      resume: () => e.resume(),
      stop: () => e.stop(),
      hangUp: () => e.hangUp(),
      toggleMute: () => e.toggleMute(),
      sendDigits: (d) => e.sendDigits(d),
      submitDisposition: (input) => e.submitDisposition(input),
      answerIncoming: () => e.answerIncoming(),
      declineIncoming: () => e.declineIncoming(),
      callNumber: (phone) => e.callNumber(phone),
    }),
    [e],
  );
  return { state, controls };
}
