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

/** The shared engine instance (created lazily). */
export function getDialerEngine(): DialerEngine {
  if (!engine) engine = new DialerEngine({ api, telephony });
  return engine;
}

/** Stops and discards the shared engine (call on sign-out). Hangs up and releases its locks. */
export async function resetDialerEngine(): Promise<void> {
  if (engine) {
    const e = engine;
    engine = null;
    await e.dispose();
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
