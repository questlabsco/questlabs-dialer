/**
 * The app-wide data layer. Import `api` from here, never a concrete implementation.
 * Demo mode is selected automatically unless BOTH VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.
 */
import type { Api } from './Api';
import { demoApi } from './demoApi';
import { SupabaseApi } from './supabaseApi';

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? '';
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? '';

/** True when running against the in-browser demo data layer with simulated calls. */
export const isDemo: boolean = !(url && anonKey);

export const api: Api = isDemo ? demoApi : new SupabaseApi(url, anonKey);

export type { Api } from './Api';
export { ApiError, isApiError, errorMessage } from './Api';
