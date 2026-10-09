import { CapacitorHttp } from '@capacitor/core';
import { getBackgroundBearer } from './background.js';

export interface MobileAccount {
  id:string;
  name:string;
  api_key:string;
  enabled:number;
  auth_mode?:'api_key'|'oauth'|string;
  oauth_client_id?:string|null;
  oauth_scope?:string|null;
}

async function bearer(account:MobileAccount):Promise<string>{
  if(account.auth_mode==='oauth')return getBackgroundBearer(account.id);
  if(!account.api_key?.startsWith('re_'))throw new Error(`Resend API key is unavailable for ${account.name}`);
  return account.api_key;
}

async function request<T>(account: MobileAccount, path: string, method = 'GET', data?: unknown, extraHeaders: Record<string,string> = {}): Promise<T> {
  const token=await bearer(account);
  const response = await CapacitorHttp.request({
    url: `https://api.resend.com${path}`,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    data,
    connectTimeout: 20_000,
    readTimeout: 30_000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(String(response.data?.message || response.data?.error || `Resend HTTP ${response.status}`));
  }
  return response.data as T;
}
const qs = (args: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) if (v !== undefined) p.set(k, String(v));
  return p.size ? `?${p.toString()}` : '';
};

export const mobileResend = {
  listReceived: (a: MobileAccount, opts: { limit?: number; after?: string } = {}) => request<any>(a, `/emails/receiving${qs(opts)}`),
  getReceived: (a: MobileAccount, id: string) => request<any>(a, `/emails/receiving/${encodeURIComponent(id)}`),
  listReceivedAttachments: (a: MobileAccount, id: string) => request<any>(a, `/emails/receiving/${encodeURIComponent(id)}/attachments`),
  getReceivedAttachment: (a: MobileAccount, emailId: string, attachmentId: string) => request<any>(a, `/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`),
  listSent: (a: MobileAccount, opts: { limit?: number; after?: string } = {}) => request<any>(a, `/emails${qs(opts)}`),
  getSent: (a: MobileAccount, id: string) => request<any>(a, `/emails/${encodeURIComponent(id)}`),
  listDomains: (a: MobileAccount) => request<any>(a, '/domains'),
  send: (a: MobileAccount, payload: any, idempotencyKey: string) =>
    request<{ id: string }>(a, '/emails', 'POST', payload, { 'Idempotency-Key': idempotencyKey }),
};
