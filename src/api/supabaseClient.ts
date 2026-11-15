/**
 * The app's single Supabase client (public URL + anon key only).
 * Works when the app is loaded from file:// in Electron: the session lives in localStorage and is
 * never read from the URL.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

function storage(): Storage | undefined {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* access denied */
  }
  return undefined;
}

/** Lazily created singleton from VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Throws if they are unset. */
export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? '';
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? '';
  if (!url || !anonKey) {
    throw new Error('Supabase is not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env and rebuild the app.');
  }
  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: storage(),
      storageKey: 'questlabs.supabase.auth',
    },
  });
  return client;
}
