export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin' });
  if (!r.ok) {
    const body = await safeJson(r);
    throw new ApiError(r.status, body, `GET ${path} → ${r.status}`);
  }
  return (await r.json()) as T;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  // Only declare a JSON Content-Type when we actually have a body. Fastify
  // rejects `POST` with `Content-Type: application/json` + empty body as
  // `FST_ERR_CTP_EMPTY_JSON_BODY` (400). Our retry / enable / disable
  // endpoints all take no body.
  const init: RequestInit = { method: 'POST', credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const r = await fetch(path, init);
  if (!r.ok) {
    const j = await safeJson(r);
    throw new ApiError(r.status, j, `POST ${path} → ${r.status}`);
  }
  return (await r.json()) as T;
}

export async function apiDelete<T>(path: string): Promise<T> {
  const r = await fetch(path, { method: 'DELETE', credentials: 'same-origin' });
  if (!r.ok) {
    const j = await safeJson(r);
    throw new ApiError(r.status, j, `DELETE ${path} → ${r.status}`);
  }
  return (await r.json()) as T;
}

async function safeJson(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return null;
  }
}

export function formatTs(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
