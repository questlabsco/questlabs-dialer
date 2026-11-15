// Shared HTTP helpers for Edge Functions (Deno): CORS, JSON responses, typed errors.
// Error bodies look like { "error": { "code": ApiErrorCode, "message": string } }.

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

/** Same codes as the app's ApiError. */
export type ErrorCode = 'not_authenticated' | 'permission_denied' | 'not_found' | 'invalid' | 'conflict' | 'not_implemented';

const STATUS: Record<ErrorCode, number> = {
  not_authenticated: 401,
  permission_denied: 403,
  not_found: 404,
  invalid: 400,
  conflict: 409,
  not_implemented: 501,
};

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status ?? STATUS[code];
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: { code: e.code, message: e.message } }, e.status);
  console.error(e);
  const message = e instanceof Error ? e.message : String(e);
  return json({ error: { code: 'invalid', message: message || 'Something went wrong.' } }, 500);
}

/** Answers CORS preflight; returns null for other methods. */
export function handleOptions(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: corsHeaders }) : null;
}

/** Maps a Postgres error raised by 0001_core.sql (custom SQLSTATEs) to an HttpError. */
export function fromPostgres(err: { code?: string; message?: string } | null | undefined, fallback = 'Database error.'): HttpError {
  const code = err?.code ?? '';
  const message = err?.message || fallback;
  switch (code) {
    case 'QL401':
      return new HttpError('not_authenticated', message);
    case 'QL403':
    case 'QL423':
    case '42501':
      return new HttpError('permission_denied', message);
    case 'QL404':
      return new HttpError('not_found', message);
    case 'QL409':
    case '23505':
      return new HttpError('conflict', message);
    default:
      return new HttpError('invalid', message, code.startsWith('QL') || code.startsWith('22') || code.startsWith('23') ? 400 : 500);
  }
}
