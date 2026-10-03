import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, newId, now, previewOf, resolveThread, setSetting, touchThread } from './db.js';
import { config } from './config.js';
import { resend } from './resend.js';

let syncing = false;

function splitAddress(value = ''): { name: string | null; address: string } {
  const match = value.match(/^\s*(?:"?([^"]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/);
  if (match) return { name: match[1]?.trim() || null, address: match[2].trim().toLowerCase() };
  return { name: null, address: value.trim().toLowerCase() };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function header(headers: any, name: string): string | null {
  if (!headers) return null;
  if (Array.isArray(headers)) {
    const found = headers.find((h: any) => String(h?.name ?? '').toLowerCase() === name.toLowerCase());
    return found?.value ? String(found.value) : null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return value == null ? null : String(value);
  }
  return null;
}

function parseReferences(value: string | null): string[] {
  if (!value) return [];
  const angle = value.match(/<[^>]+>/g);
  return angle?.length ? angle : value.split(/\s+/).filter(Boolean);
}

function extractList(result: any): { data: any[]; hasMore: boolean } {
  const envelope = result?.data && !Array.isArray(result.data) && result.data.data ? result.data : result;
  return {
    data: Array.isArray(envelope?.data) ? envelope.data : [],
    hasMore: Boolean(envelope?.has_more),
  };
}

async function listAll(listFn: (opts: any) => Promise<any>): Promise<any[]> {
  const output: any[] = [];
  let after: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const response = extractList(await listFn({ limit: 100, after }));
    if (!response.data.length) break;
    output.push(...response.data);
    if (!response.hasMore) break;
    after = response.data[response.data.length - 1]?.id;
    if (!after) break;
  }
  return output;
}

function insertMessage(input: {
  providerId: string;
  direction: 'inbound' | 'outbound';
  status: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  text?: string | null;
  html?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  createdAt: string;
}): string | null {
  const exists = db.prepare('SELECT id FROM messages WHERE provider_id = ?').get(input.providerId) as { id: string } | undefined;
  if (exists) return null;

  const parsed = splitAddress(input.from);
  const threadId = resolveThread({
    subject: input.subject,
    messageId: input.messageId,
    inReplyTo: input.inReplyTo,
    references: input.references,
    createdAt: input.createdAt,
  });
  const id = newId();

  db.prepare(`
    INSERT INTO messages(
      id,thread_id,provider_id,direction,status,from_address,from_name,
      to_json,cc_json,bcc_json,reply_to_json,subject,text_body,html_body,preview,
      message_id_header,in_reply_to,references_json,created_at,received_at,sent_at,is_read
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, threadId, input.providerId, input.direction, input.status,
    parsed.address, parsed.name,
    JSON.stringify(input.to), JSON.stringify(input.cc ?? []), JSON.stringify(input.bcc ?? []),
    JSON.stringify(input.replyTo ?? []), input.subject, input.text ?? null, input.html ?? null,
    previewOf(input.text, input.html), input.messageId ?? null, input.inReplyTo ?? null,
    JSON.stringify(input.references ?? []), input.createdAt,
    input.direction === 'inbound' ? input.createdAt : null,
    input.direction === 'outbound' ? input.createdAt : null,
    input.direction === 'outbound' ? 1 : 0
  );
  touchThread(threadId, input.subject, input.createdAt);
  return id;
}

async function downloadInboundAttachments(providerId: string, localMessageId: string): Promise<void> {
  let response: any;
  try {
    response = await resend.listReceivedAttachments(providerId);
  } catch {
    return;
  }
  const { data } = extractList(response);
  const dir = path.join(config.dataDir, 'attachments', localMessageId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  for (const item of data) {
    const exists = db.prepare('SELECT 1 FROM attachments WHERE provider_attachment_id = ? AND message_id = ?')
      .get(item.id, localMessageId);
    if (exists) continue;

    let localPath: string | null = null;
    let sizeBytes: number | null = item.size ?? null;
    const downloadUrl = item.download_url ?? item.downloadUrl;
    if (downloadUrl) {
      try {
        const r = await fetch(downloadUrl, { signal: AbortSignal.timeout(30_000) });
        if (r.ok) {
          const declared = Number(r.headers.get('content-length') || 0);
          if (!declared || declared <= config.maxAttachmentBytes) {
            const bytes = Buffer.from(await r.arrayBuffer());
            if (bytes.length <= config.maxAttachmentBytes) {
              const safe = String(item.filename || 'attachment').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 180);
              const target = path.join(dir, `${item.id}-${safe}`);
              fs.writeFileSync(target, bytes, { mode: 0o600 });
              localPath = target;
              sizeBytes = bytes.length;
            }
          }
        }
      } catch {
        // Metadata is still stored; a later sync can retry.
      }
    }

    db.prepare(`
      INSERT INTO attachments(id,message_id,provider_attachment_id,filename,content_type,size_bytes,local_path,created_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(
      newId(), localMessageId, item.id ?? null, item.filename ?? 'attachment',
      item.content_type ?? item.contentType ?? 'application/octet-stream',
      sizeBytes, localPath, now()
    );
  }
}

async function syncInbound(): Promise<number> {
  const list = await listAll(resend.listReceived);
  let count = 0;
  for (const summary of [...list].reverse()) {
    if (db.prepare('SELECT 1 FROM messages WHERE provider_id = ?').get(summary.id)) continue;
    const detail = await resend.getReceived(summary.id);
    const value = detail?.data ?? detail;
    const headers = value.headers ?? {};
    const messageId = value.message_id ?? header(headers, 'message-id');
    const inReplyTo = header(headers, 'in-reply-to');
    const references = parseReferences(header(headers, 'references'));
    const localId = insertMessage({
      providerId: value.id ?? summary.id,
      direction: 'inbound',
      status: 'received',
      from: value.from ?? summary.from ?? '',
      to: strings(value.to ?? summary.to),
      cc: strings(value.cc ?? summary.cc),
      bcc: strings(value.bcc ?? summary.bcc),
      replyTo: strings(value.reply_to ?? value.replyTo),
      subject: value.subject ?? summary.subject ?? '',
      text: value.text ?? null,
      html: value.html ?? null,
      messageId,
      inReplyTo,
      references,
      createdAt: value.created_at ?? summary.created_at ?? now(),
    });
    if (localId) {
      await downloadInboundAttachments(summary.id, localId);
      count++;
    }
  }
  return count;
}

async function syncSent(): Promise<number> {
  const list = await listAll(resend.listSent);
  let count = 0;
  for (const summary of [...list].reverse()) {
    if (db.prepare('SELECT 1 FROM messages WHERE provider_id = ?').get(summary.id)) continue;
    const detail = await resend.getSent(summary.id);
    const value = detail?.data ?? detail;
    const headers = value.headers ?? {};
    const localId = insertMessage({
      providerId: value.id ?? summary.id,
      direction: 'outbound',
      status: value.last_event ?? value.status ?? 'sent',
      from: value.from ?? summary.from ?? '',
      to: strings(value.to ?? summary.to),
      cc: strings(value.cc ?? summary.cc),
      bcc: strings(value.bcc ?? summary.bcc),
      replyTo: strings(value.reply_to ?? value.replyTo),
      subject: value.subject ?? summary.subject ?? '',
      text: value.text ?? null,
      html: value.html ?? null,
      messageId: value.message_id ?? header(headers, 'message-id'),
      inReplyTo: header(headers, 'in-reply-to'),
      references: parseReferences(header(headers, 'references')),
      createdAt: value.created_at ?? summary.created_at ?? now(),
    });
    if (localId) count++;
  }
  return count;
}

export async function syncAll(): Promise<{ inbound: number; sent: number }> {
  if (syncing) return { inbound: 0, sent: 0 };
  if (!config.resendApiKey) throw new Error('RESEND_API_KEY is not configured');
  syncing = true;
  try {
    const inbound = await syncInbound();
    const sent = await syncSent();
    setSetting('last_sync_at', now());
    setSetting('last_sync_error', '');
    return { inbound, sent };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setSetting('last_sync_error', message);
    throw error;
  } finally {
    syncing = false;
  }
}

export function isSyncing(): boolean {
  return syncing;
}

export function startSyncLoop(): () => void {
  const timer = setInterval(() => void syncAll().catch(() => undefined), config.syncSeconds * 1000);
  timer.unref();
  setTimeout(() => void syncAll().catch(() => undefined), 1000).unref();
  return () => clearInterval(timer);
}

export async function flushOutbox(): Promise<number> {
  if (!config.resendApiKey) return 0;
  const rows = db.prepare(`
    SELECT * FROM messages WHERE direction='outbound' AND status='queued' AND deleted_at IS NULL
    ORDER BY created_at ASC LIMIT 20
  `).all() as any[];
  let sent = 0;
  for (const row of rows) {
    try {
      const attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(row.id) as any[];
      const payload: any = {
        from: row.from_address,
        to: JSON.parse(row.to_json),
        cc: JSON.parse(row.cc_json),
        bcc: JSON.parse(row.bcc_json),
        subject: row.subject,
        text: row.text_body || undefined,
        html: row.html_body || undefined,
      };
      if (row.in_reply_to) {
        payload.headers = {
          'In-Reply-To': row.in_reply_to,
          'References': JSON.parse(row.references_json).join(' '),
        };
      }
      if (attachments.length) {
        payload.attachments = attachments
          .filter(a => a.local_path && fs.existsSync(a.local_path))
          .map(a => ({
            filename: a.filename,
            content: fs.readFileSync(a.local_path).toString('base64'),
            content_type: a.content_type,
          }));
      }
      const response = await resend.send(payload, `gibp-mail-${row.id}`);
      db.prepare(`
        UPDATE messages SET provider_id=?,status='sent',sent_at=?,last_error=NULL,is_read=1 WHERE id=?
      `).run(response.id, now(), row.id);
      sent++;
    } catch (error) {
      db.prepare('UPDATE messages SET last_error=? WHERE id=?')
        .run(error instanceof Error ? error.message : String(error), row.id);
    }
  }
  return sent;
}

export function startOutboxLoop(): () => void {
  const timer = setInterval(() => void flushOutbox(), 15_000);
  timer.unref();
  setTimeout(() => void flushOutbox(), 2500).unref();
  return () => clearInterval(timer);
}
