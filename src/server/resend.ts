import { config } from './config.js';

type Json = Record<string, any>;

async function request<T = Json>(path: string, init: RequestInit = {}): Promise<T> {
  if (!config.resendApiKey) throw new Error('RESEND_API_KEY is not configured');
  const response = await fetch(`https://api.resend.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Resend HTTP ${response.status}`);
  }
  return data as T;
}

function qs(input: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) if (v !== undefined) p.set(k, String(v));
  const value = p.toString();
  return value ? `?${value}` : '';
}

export const resend = {
  listReceived: (options: { limit?: number; after?: string; before?: string } = {}) =>
    request<any>(`/emails/receiving${qs(options)}`),

  getReceived: (id: string) =>
    request<any>(`/emails/receiving/${encodeURIComponent(id)}`),

  listReceivedAttachments: (id: string) =>
    request<any>(`/emails/receiving/${encodeURIComponent(id)}/attachments`),

  listSent: (options: { limit?: number; after?: string; before?: string } = {}) =>
    request<any>(`/emails${qs(options)}`),

  getSent: (id: string) =>
    request<any>(`/emails/${encodeURIComponent(id)}`),

  send: (payload: Record<string, unknown>, idempotencyKey: string) =>
    request<{ id: string }>('/emails', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(payload),
    }),
};
