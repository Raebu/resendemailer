import { Capacitor } from '@capacitor/core';

export async function mailApi<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  if (Capacitor.isNativePlatform()) {
    const { mobileRequest } = await import('../mobile/router.js');
    return mobileRequest<T>(url, init);
  }
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data as T;
}

export async function openAttachment(id: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { openMobileAttachment } = await import('../mobile/router.js');
    await openMobileAttachment(id);
    return;
  }
  window.open(`/api/attachments/${encodeURIComponent(id)}`, '_blank', 'noopener,noreferrer');
}
