import { Directory, Filesystem } from '@capacitor/filesystem';
import { all, isoNow, json, messagePreview, nextRevision, normalizeSubject, one, run, uid } from './db.js';
import { mobileResend, type MobileAccount } from './resend.js';

type SyncResult = { inbound: number; sent: number; newInboundIds: string[]; errors: string[] };

function listEnvelope(value: any): { data: any[]; hasMore: boolean } {
  const x = value?.data && !Array.isArray(value.data) && Array.isArray(value.data.data) ? value.data : value;
  return { data: Array.isArray(x?.data) ? x.data : [], hasMore: Boolean(x?.has_more) };
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}
function getHeader(headers: any, name: string): string | null {
  if (!headers) return null;
  if (Array.isArray(headers)) {
    const found = headers.find((h: any) => String(h?.name || '').toLowerCase() === name.toLowerCase());
    return found?.value ? String(found.value) : null;
  }
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name.toLowerCase()) return v == null ? null : String(v);
  return null;
}
function references(value: string | null): string[] {
  if (!value) return [];
  return value.match(/<[^>]+>/g) || value.split(/\s+/).filter(Boolean);
}
function parseFrom(value: string): { address: string; name: string | null } {
  const m = value.match(/^\s*(?:"?([^"]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/);
  return m ? { name: m[1]?.trim() || null, address: m[2].toLowerCase() } : { name: null, address: value.trim().toLowerCase() };
}

async function allPages(account: MobileAccount, kind: 'received' | 'sent'): Promise<any[]> {
  const output: any[] = [];
  let after: string | undefined;
  for (let i = 0; i < 250; i++) {
    const raw = kind === 'received'
      ? await mobileResend.listReceived(account, { limit: 100, after })
      : await mobileResend.listSent(account, { limit: 100, after });
    const page = listEnvelope(raw);
    if (!page.data.length) break;
    output.push(...page.data);
    if (!page.hasMore) break;
    after = page.data.at(-1)?.id;
    if (!after) break;
  }
  return output;
}

async function resolveThread(subject: string, inReplyTo: string | null, refs: string[], createdAt: string): Promise<string> {
  for (const ref of [inReplyTo, ...refs].filter(Boolean) as string[]) {
    const hit = await one<{ thread_id: string }>('SELECT thread_id FROM messages WHERE message_id_header=? ORDER BY created_at DESC LIMIT 1', [ref]);
    if (hit) return hit.thread_id;
  }
  const normalized = normalizeSubject(subject);
  if (normalized) {
    const hit = await one<{ id: string }>(
      "SELECT id FROM threads WHERE normalized_subject=? AND updated_at>=datetime(?,'-30 days') ORDER BY updated_at DESC LIMIT 1",
      [normalized, createdAt],
    );
    if (hit) return hit.id;
  }
  const id = uid('thr_');
  await run('INSERT INTO threads(id,subject,normalized_subject,created_at,updated_at) VALUES(?,?,?,?,?)', [id, subject, normalized, createdAt, createdAt]);
  return id;
}

async function saveMessage(account: MobileAccount, value: any, direction: 'inbound' | 'outbound'): Promise<string | null> {
  const providerId = String(value.id || '');
  if (!providerId) return null;
  const providerKey = `${account.id}:${providerId}`;
  if (await one('SELECT id FROM messages WHERE provider_key=?', [providerKey])) return null;

  const headers = value.headers || {};
  const messageId = value.message_id || getHeader(headers, 'message-id');
  const inReplyTo = getHeader(headers, 'in-reply-to');
  const refs = references(getHeader(headers, 'references'));
  const createdAt = value.created_at || isoNow();
  const subject = value.subject || '';
  const from = parseFrom(value.from || '');
  const threadId = await resolveThread(subject, inReplyTo, refs, createdAt);
  const id = uid('msg_');
  const revision = await nextRevision();

  await run(`
    INSERT INTO messages(
      id,account_id,thread_id,provider_id,provider_key,direction,status,from_address,from_name,
      to_json,cc_json,bcc_json,reply_to_json,subject,text_body,html_body,preview,message_id_header,
      in_reply_to,references_json,created_at,received_at,sent_at,is_read,revision
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [
    id, account.id, threadId, providerId, providerKey, direction,
    direction === 'inbound' ? 'received' : (value.last_event || value.status || 'sent'),
    from.address, from.name, JSON.stringify(stringArray(value.to)), JSON.stringify(stringArray(value.cc)),
    JSON.stringify(stringArray(value.bcc)), JSON.stringify(stringArray(value.reply_to || value.replyTo)),
    subject, value.text || null, value.html || null, messagePreview(value.text, value.html),
    messageId || null, inReplyTo, JSON.stringify(refs), createdAt,
    direction === 'inbound' ? createdAt : null, direction === 'outbound' ? createdAt : null,
    direction === 'outbound' ? 1 : 0, revision,
  ]);
  await run('UPDATE threads SET updated_at=CASE WHEN updated_at<? THEN ? ELSE updated_at END WHERE id=?', [createdAt, createdAt, threadId]);
  return id;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 160) || 'attachment';
}

async function saveInboundAttachments(account: MobileAccount, providerEmailId: string, localMessageId: string): Promise<void> {
  try {
    const raw = await mobileResend.listReceivedAttachments(account, providerEmailId);
    const items = listEnvelope(raw).data;
    for (const item of items) {
      if (await one('SELECT id FROM attachments WHERE message_id=? AND provider_attachment_id=?', [localMessageId, item.id])) continue;
      const attachmentId = uid('att_');
      let localPath: string | null = null;
      let size = Number(item.size || 0) || null;
      try {
        const detailRaw = await mobileResend.getReceivedAttachment(account, providerEmailId, item.id);
        const detail = detailRaw?.data || detailRaw;
        const base64 = detail?.content || detail?.base64 || null;
        if (typeof base64 === 'string' && base64.length) {
          const rel = `attachments/${localMessageId}/${attachmentId}-${safeName(item.filename || detail.filename || 'attachment')}`;
          await Filesystem.writeFile({ path: rel, data: base64, directory: Directory.Data, recursive: true });
          const uri = await Filesystem.getUri({ path: rel, directory: Directory.Data });
          localPath = uri.uri;
          size = size || Math.floor(base64.length * 0.75);
        }
      } catch {
        // Keep metadata. A foreground refresh can retry the file later.
      }
      await run(
        'INSERT INTO attachments(id,message_id,provider_attachment_id,filename,content_type,size_bytes,local_path,created_at) VALUES(?,?,?,?,?,?,?,?)',
        [attachmentId, localMessageId, item.id || null, item.filename || 'attachment', item.content_type || item.contentType || 'application/octet-stream', size, localPath, isoNow()],
      );
    }
  } catch {
    // Some accounts/messages have no attachments.
  }
}

export async function refreshDomains(account: MobileAccount): Promise<number> {
  const raw = await mobileResend.listDomains(account);
  const items = listEnvelope(raw).data;
  let count = 0;
  for (const d of items) {
    const name = String(d.name || d.domain || '').toLowerCase();
    if (!name) continue;
    const status = String(d.status || 'unknown');
    await run(
      `INSERT INTO domains(id,account_id,domain,status,can_send,can_receive,created_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(account_id,domain) DO UPDATE SET status=excluded.status,can_send=excluded.can_send,can_receive=excluded.can_receive`,
      [uid('dom_'), account.id, name, status, status === 'verified' ? 1 : 0, d.capabilities?.receiving === 'enabled' || d.receiving === 'enabled' ? 1 : 0, isoNow()],
    );
    count++;
  }
  return count;
}

async function syncAccount(account: MobileAccount): Promise<SyncResult> {
  const result: SyncResult = { inbound: 0, sent: 0, newInboundIds: [], errors: [] };
  try { await refreshDomains(account); } catch (e) { result.errors.push(`domains: ${e instanceof Error ? e.message : String(e)}`); }

  try {
    const inbound = await allPages(account, 'received');
    for (const summary of [...inbound].reverse()) {
      if (await one('SELECT id FROM messages WHERE provider_key=?', [`${account.id}:${summary.id}`])) continue;
      try {
        const raw = await mobileResend.getReceived(account, summary.id);
        const detail = raw?.data || raw;
        const id = await saveMessage(account, detail, 'inbound');
        if (id) {
          result.inbound++;
          result.newInboundIds.push(id);
          await saveInboundAttachments(account, summary.id, id);
        }
      } catch (e) { result.errors.push(`inbound ${summary.id}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  } catch (e) { result.errors.push(`received list: ${e instanceof Error ? e.message : String(e)}`); }

  try {
    const sent = await allPages(account, 'sent');
    for (const summary of [...sent].reverse()) {
      if (await one('SELECT id FROM messages WHERE provider_key=?', [`${account.id}:${summary.id}`])) continue;
      try {
        const raw = await mobileResend.getSent(account, summary.id);
        if (await saveMessage(account, raw?.data || raw, 'outbound')) result.sent++;
      } catch (e) { result.errors.push(`sent ${summary.id}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  } catch (e) { result.errors.push(`sent list: ${e instanceof Error ? e.message : String(e)}`); }

  const error = result.errors.join('; ').slice(0, 4000);
  await run('UPDATE accounts SET last_sync_at=?,last_error=?,updated_at=? WHERE id=?', [isoNow(), error || null, isoNow(), account.id]);
  return result;
}

export async function syncAllAccounts(): Promise<SyncResult> {
  const accounts = await all<MobileAccount>('SELECT * FROM accounts WHERE enabled=1 ORDER BY created_at');
  const total: SyncResult = { inbound: 0, sent: 0, newInboundIds: [], errors: [] };
  for (const account of accounts) {
    const r = await syncAccount(account);
    total.inbound += r.inbound;
    total.sent += r.sent;
    total.newInboundIds.push(...r.newInboundIds);
    total.errors.push(...r.errors.map(x => `${account.name}: ${x}`));
  }
  return total;
}

export async function accountForSender(address: string): Promise<MobileAccount> {
  const domain = address.split('@')[1]?.toLowerCase();
  if (!domain) throw new Error('Invalid From address');
  const hit = await one<MobileAccount & { status: string }>(
    `SELECT a.* FROM accounts a JOIN domains d ON d.account_id=a.id
     WHERE a.enabled=1 AND d.domain=? AND d.can_send=1 AND d.status='verified' LIMIT 1`,
    [domain],
  );
  if (!hit) throw new Error(`No connected Resend account has verified sending domain ${domain}`);
  return hit;
}

export async function queueAndSend(input: {
  draftId?: string; from: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string;
  text: string; replyToMessageId?: string | null; attachments?: Array<{ filename: string; contentType?: string; base64: string }>;
}): Promise<{ id: string; status: string; error?: string }> {
  const account = await accountForSender(input.from);
  let parent: any = null;
  if (input.replyToMessageId) parent = await one('SELECT * FROM messages WHERE id=?', [input.replyToMessageId]);
  const refs = parent ? [...json<string[]>(parent.references_json, []), parent.message_id_header].filter(Boolean) : [];
  const threadId = parent?.thread_id || await resolveThread(input.subject, parent?.message_id_header || null, refs, isoNow());
  const id = uid('msg_');
  const createdAt = isoNow();
  const revision = await nextRevision();
  const escaped = input.text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] || c)).replace(/\n/g, '<br>');

  await run(
    `INSERT INTO messages(id,account_id,thread_id,direction,status,from_address,to_json,cc_json,bcc_json,reply_to_json,
       subject,text_body,html_body,preview,in_reply_to,references_json,created_at,is_read,revision)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, account.id, threadId, 'outbound', 'queued', input.from.toLowerCase(), JSON.stringify(input.to), JSON.stringify(input.cc || []),
      JSON.stringify(input.bcc || []), '[]', input.subject, input.text, `<div>${escaped}</div>`, messagePreview(input.text, null),
      parent?.message_id_header || null, JSON.stringify(refs), createdAt, 1, revision],
  );

  for (const attachment of input.attachments || []) {
    const attachmentId = uid('att_');
    const rel = `attachments/${id}/${attachmentId}-${safeName(attachment.filename)}`;
    await Filesystem.writeFile({ path: rel, data: attachment.base64, directory: Directory.Data, recursive: true });
    const uri = await Filesystem.getUri({ path: rel, directory: Directory.Data });
    await run(
      'INSERT INTO attachments(id,message_id,filename,content_type,size_bytes,local_path,created_at) VALUES(?,?,?,?,?,?,?)',
      [attachmentId, id, attachment.filename, attachment.contentType || 'application/octet-stream', Math.floor(attachment.base64.length * 0.75), uri.uri, isoNow()],
    );
  }
  if (input.draftId) await run('DELETE FROM drafts WHERE id=?', [input.draftId]);
  return sendQueuedMessage(id);
}

export async function sendQueuedMessage(id: string): Promise<{ id: string; status: string; error?: string }> {
  const row: any = await one('SELECT * FROM messages WHERE id=?', [id]);
  if (!row) throw new Error('Message not found');
  if (row.status !== 'queued') return { id, status: row.status };
  const account = await one<MobileAccount>('SELECT * FROM accounts WHERE id=? AND enabled=1', [row.account_id]);
  if (!account) throw new Error('Resend account unavailable');
  const attachments = await all<any>('SELECT * FROM attachments WHERE message_id=?', [id]);
  const payload: any = {
    from: row.from_address,
    to: json(row.to_json, []), cc: json(row.cc_json, []), bcc: json(row.bcc_json, []),
    subject: row.subject, text: row.text_body || undefined, html: row.html_body || undefined,
  };
  if (row.in_reply_to) payload.headers = { 'In-Reply-To': row.in_reply_to, 'References': json<string[]>(row.references_json, []).join(' ') };
  if (attachments.length) {
    payload.attachments = [];
    for (const a of attachments) {
      if (!a.local_path) continue;
      try {
        const file = await Filesystem.readFile({ path: a.local_path });
        payload.attachments.push({ filename: a.filename, content: file.data, content_type: a.content_type });
      } catch { /* skip unavailable local file */ }
    }
  }
  try {
    const sent = await mobileResend.send(account, payload, `gibp-mobile-${id}`);
    const rev = await nextRevision();
    await run('UPDATE messages SET provider_id=?,provider_key=?,status=?,sent_at=?,last_error=NULL,revision=? WHERE id=?',
      [sent.id, `${account.id}:${sent.id}`, 'sent', isoNow(), rev, id]);
    return { id, status: 'sent' };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await run('UPDATE messages SET last_error=? WHERE id=?', [error, id]);
    return { id, status: 'queued', error };
  }
}

export async function flushMobileOutbox(limit = 20): Promise<number> {
  const rows = await all<{ id: string }>("SELECT id FROM messages WHERE status='queued' AND deleted_at IS NULL ORDER BY created_at LIMIT ?", [limit]);
  let sent = 0;
  for (const row of rows) if ((await sendQueuedMessage(row.id)).status === 'sent') sent++;
  return sent;
}
