/** The app-wide telephony provider: simulated in demo mode, Telnyx otherwise. */
import { api, isDemo } from '../api';
import type { Telephony } from './Telephony';
import { SimulatedTelephony } from './simulated';
import { TelnyxTelephony } from './telnyx';

export const telephony: Telephony = isDemo
  ? new SimulatedTelephony()
  : new TelnyxTelephony({ getToken: () => api.getTelephonyToken() });

export type { Telephony, TelephonyEvent, TelephonyListener, DialRequest, EndReason } from './Telephony';
