/**
 * The Supabase side of TelnyxTelephony: Edge Function calls and the Realtime subscription to the
 * signed-in caller's telephony_events rows. Isolated behind `TelnyxBackend` so the telephony logic
 * can be unit-tested with a fake.
 */
import type { TelephonyEventRow } from '../../supabase/functions/_shared/telnyxLogic';
import { getSupabase } from '../api/supabaseClient';

export type SubscriptionStatus = 'subscribed' | 'lost';

export interface TelnyxBackend {
  /** Calls an Edge Function; rejects with an Error carrying the function's `error` message. */
  invoke<T>(fn: string, body: Record<string, unknown>): Promise<T>;
  /** Signed-in user's profile id. */
  userId(): Promise<string>;
  /** Highest telephony_events id visible to me (0 if none) — events before connect() are ignored. */
  latestEventId(callerId: string): Promise<number>;
  /** My events with id > afterId, ascending. */
  eventsSince(callerId: string, afterId: number): Promise<TelephonyEventRow[]>;
  /** Realtime INSERTs on telephony_events for me. Returns unsubscribe. */
  subscribe(callerId: string, onRow: (row: TelephonyEventRow) => void, onStatus: (s: SubscriptionStatus) => void): () => void;
}

async function functionErrorMessage(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown })?.context;
  if (ctx && typeof (ctx as Response).json === 'function') {
    try {
      const body = (await (ctx as Response).clone().json()) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      /* not JSON */
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export function createSupabaseTelnyxBackend(): TelnyxBackend {
  const sb = getSupabase();
  return {
    async invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
      const { data, error } = await sb.functions.invoke(fn, { body });
      if (error) throw new Error(await functionErrorMessage(error));
      return data as T;
    },
    async userId() {
      const { data, error } = await sb.auth.getUser();
      if (error || !data.user) throw new Error('You are not signed in.');
      return data.user.id;
    },
    async latestEventId(callerId) {
      const { data } = await sb
        .from('telephony_events')
        .select('id')
        .eq('caller_id', callerId)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data?.id as number | undefined) ?? 0;
    },
    async eventsSince(callerId, afterId) {
      const { data, error } = await sb
        .from('telephony_events')
        .select('*')
        .eq('caller_id', callerId)
        .gt('id', afterId)
        .order('id', { ascending: true })
        .limit(500);
      if (error) throw new Error(error.message);
      return (data ?? []) as TelephonyEventRow[];
    },
    subscribe(callerId, onRow, onStatus) {
      const channel = sb
        .channel(`telephony-events-${callerId}-${Date.now()}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'telephony_events', filter: `caller_id=eq.${callerId}` },
          (payload) => onRow(payload.new as TelephonyEventRow),
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') onStatus('subscribed');
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') onStatus('lost');
        });
      return () => {
        void sb.removeChannel(channel);
      };
    },
  };
}
