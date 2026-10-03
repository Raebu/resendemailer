import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { db, getSetting, newId, now, previewOf, resolveThread, touchThread } from './db.js';
import { flushOutbox, isSyncing, startOutboxLoop, startSyncLoop, syncAll } from './sync.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '35mb' }));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const parseIdentity = (raw: string) => {
  const match = raw.trim().match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/);
  if (match) return { name: match[1].trim(), address: match[2].toLowerCase(), formatted: raw.trim() };
  return { name: '', address: raw.trim().toLowerCase(), formatted: raw.trim() };
};
const identities = config.identitiesRaw.split(',').map(parseIdentity).filter(x => x.address.includes('@'));
const jsonArray = (s: string | null | undefined) => {
  try { return JSON.parse(s || '[]'); } catch { return []; }
};

function toSummary(row: any) {
  return {
    id: row.id,
    threadId: row.thread_id,
    providerId: row.provider_id,
    direction: row.direction,
    status: row.status,
    fromAddress: row.from_address,
    fromName: row.from_name,
    toAddresses: jsonArray(row.to_json),
    ccAddresses: jsonArray(row.cc_json),
    subject: row.subject,
    preview: row.preview,
    createdAt: row.created_at,
    receivedAt: row.received_at,
    sentAt: row.sent_at,
    isRead: Boolean(row.is_read),
    isStarred: Boolean(row.is_starred),
    isArchived: Boolean(row.is_archived),
    deletedAt: row.deleted_at,
    attachmentCount: Number(row.attachment_count || 0),
    threadCount: Number(row.thread_count || 1),
  };
}

function messageDetail(row: any) {
  const attachments = db.prepare('SELECT * FROM attachments WHERE message_id=? ORDER BY created_at').all(row.id) as any[];
  return {
    ...toSummary(row),
    bccAddresses: jsonArray(row.bcc_json),
    replyToAddresses: jsonArray(row.reply_to_json),
    textBody: row.text_body,
    htmlBody: row.html_body,
    messageIdHeader: row.message_id_header,
    inReplyTo: row.in_reply_to,
    references: jsonArray(row.references_json),
    attachments: attachments.map(a => ({
      id: a.id, messageId: a.message_id, providerAttachmentId: a.provider_attachment_id,
      filename: a.filename, contentType: a.content_type, sizeBytes: a.size_bytes, localPath: a.local_path,
    })),
  };
}

app.get('/api/status', (_req, res) => {
  const queued = (db.prepare("SELECT count(*) n FROM messages WHERE status='queued'").get() as any).n;
  res.json({
    configured: Boolean(config.resendApiKey),
    syncing: isSyncing(),
    lastSyncAt: getSetting('last_sync_at'),
    lastSyncError: getSetting('last_sync_error') || null,
    dataDir: config.dataDir,
    queued,
  });
});

app.get('/api/identities', (_req, res) => res.json(identities));

app.post('/api/sync', async (_req, res) => {
  try {
    const result = await syncAll();
    const queuedSent = await flushOutbox();
    res.json({ ...result, queuedSent });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/messages', (req, res) => {
  const folder = String(req.query.folder || 'inbox');
  const query = String(req.query.q || '').trim();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));

  let where = 'm.deleted_at IS NULL';
  if (folder === 'inbox') where += " AND m.direction='inbound' AND m.is_archived=0";
  else if (folder === 'sent') where += " AND m.direction='outbound' AND m.status NOT IN ('queued','draft')";
  else if (folder === 'outbox') where += " AND m.direction='outbound' AND m.status='queued'";
  else if (folder === 'archive') where += ' AND m.is_archived=1';
  else if (folder === 'trash') where = 'm.deleted_at IS NOT NULL';
  else if (folder === 'starred') where += ' AND m.is_starred=1';

  let rows: any[];
  const select = `
    SELECT m.*,
      (SELECT count(*) FROM attachments a WHERE a.message_id=m.id) attachment_count,
      (SELECT count(*) FROM messages tm WHERE tm.thread_id=m.thread_id AND tm.deleted_at IS NULL) thread_count
    FROM messages m
  `;
  if (query) {
    rows = db.prepare(`
      ${select}
      JOIN messages_fts f ON f.message_id=m.id
      WHERE ${where} AND messages_fts MATCH ?
      ORDER BY m.created_at DESC LIMIT ?
    `).all(query.replace(/["']/g, ' '), limit) as any[];
  } else {
    rows = db.prepare(`${select} WHERE ${where} ORDER BY m.created_at DESC LIMIT ?`).all(limit) as any[];
  }

  // One representative row per thread outside outbox; latest wins.
  const seen = new Set<string>();
  const result = rows.filter(row => {
    if (folder === 'outbox') return true;
    if (seen.has(row.thread_id)) return false;
    seen.add(row.thread_id);
    return true;
  }).map(toSummary);
  res.json(result);
});

app.get('/api/threads/:id', (req, res) => {
  const thread = db.prepare('SELECT * FROM threads WHERE id=?').get(req.params.id) as any;
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const rows = db.prepare(`
    SELECT m.*,
      (SELECT count(*) FROM attachments a WHERE a.message_id=m.id) attachment_count,
      (SELECT count(*) FROM messages tm WHERE tm.thread_id=m.thread_id AND tm.deleted_at IS NULL) thread_count
    FROM messages m WHERE m.thread_id=? AND m.deleted_at IS NULL ORDER BY m.created_at
  `).all(req.params.id) as any[];
  db.prepare('UPDATE messages SET is_read=1 WHERE thread_id=?').run(req.params.id);
  res.json({ id: thread.id, subject: thread.subject, messages: rows.map(messageDetail) });
});

const patchSchema = z.object({
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  trash: z.boolean().optional(),
});
app.patch('/api/messages/:id', (req, res) => {
  const input = patchSchema.parse(req.body);
  const sets: string[] = [];
  const values: any[] = [];
  if (input.isRead !== undefined) { sets.push('is_read=?'); values.push(input.isRead ? 1 : 0); }
  if (input.isStarred !== undefined) { sets.push('is_starred=?'); values.push(input.isStarred ? 1 : 0); }
  if (input.isArchived !== undefined) { sets.push('is_archived=?'); values.push(input.isArchived ? 1 : 0); }
  if (input.trash !== undefined) { sets.push('deleted_at=?'); values.push(input.trash ? now() : null); }
  if (!sets.length) return res.json({ ok: true });
  values.push(req.params.id);
  db.prepare(`UPDATE messages SET ${sets.join(',')} WHERE id=?`).run(...values);
  res.json({ ok: true });
});

const draftSchema = z.object({
  id: z.string().optional(),
  replyToMessageId: z.string().nullable().optional(),
  fromIdentity: z.string(),
  to: z.array(z.string()).default([]),
  cc: z.array(z.string()).default([]),
  bcc: z.array(z.string()).default([]),
  subject: z.string().default(''),
  textBody: z.string().default(''),
});
app.get('/api/drafts', (_req, res) => {
  const rows = db.prepare('SELECT * FROM drafts ORDER BY updated_at DESC').all() as any[];
  res.json(rows.map(r => ({
    id:r.id, replyToMessageId:r.reply_to_message_id, fromIdentity:r.from_identity,
    to:jsonArray(r.to_json), cc:jsonArray(r.cc_json), bcc:jsonArray(r.bcc_json),
    subject:r.subject, textBody:r.text_body, updatedAt:r.updated_at,
  })));
});
app.post('/api/drafts', (req, res) => {
  const input = draftSchema.parse(req.body);
  const id = input.id || newId();
  const time = now();
  db.prepare(`
    INSERT INTO drafts(id,reply_to_message_id,from_identity,to_json,cc_json,bcc_json,subject,text_body,updated_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      reply_to_message_id=excluded.reply_to_message_id,from_identity=excluded.from_identity,
      to_json=excluded.to_json,cc_json=excluded.cc_json,bcc_json=excluded.bcc_json,
      subject=excluded.subject,text_body=excluded.text_body,updated_at=excluded.updated_at
  `).run(id,input.replyToMessageId??null,input.fromIdentity,JSON.stringify(input.to),JSON.stringify(input.cc),
    JSON.stringify(input.bcc),input.subject,input.textBody,time,time);
  res.json({ id });
});
app.delete('/api/drafts/:id', (req, res) => {
  db.prepare('DELETE FROM drafts WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

const sendSchema = z.object({
  draftId: z.string().optional(),
  from: z.string().email(),
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).default([]),
  bcc: z.array(z.string().email()).default([]),
  subject: z.string().max(998).default(''),
  text: z.string().max(2_000_000).default(''),
  replyToMessageId: z.string().nullable().optional(),
  attachments: z.array(z.object({
    filename:z.string().min(1).max(255),
    contentType:z.string().default('application/octet-stream'),
    base64:z.string(),
  })).default([]),
});
app.post('/api/send', async (req, res) => {
  const input = sendSchema.parse(req.body);
  const identityAllowed = identities.some(i => i.address.toLowerCase() === input.from.toLowerCase());
  if (!identityAllowed) return res.status(400).json({ error:'From address is not in GIBP_MAIL_IDENTITIES' });

  let inReplyTo: string | null = null;
  let references: string[] = [];
  let threadId: string | null = null;
  if (input.replyToMessageId) {
    const parent = db.prepare('SELECT * FROM messages WHERE id=?').get(input.replyToMessageId) as any;
    if (parent) {
      inReplyTo = parent.message_id_header;
      references = [...jsonArray(parent.references_json), parent.message_id_header].filter(Boolean);
      threadId = parent.thread_id;
    }
  }

  const id = newId();
  const createdAt = now();
  threadId ||= resolveThread({ subject:input.subject, inReplyTo, references, createdAt });
  const escaped = input.text.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!)).replace(/\n/g,'<br>');

  db.prepare(`
    INSERT INTO messages(
      id,thread_id,direction,status,from_address,to_json,cc_json,bcc_json,reply_to_json,
      subject,text_body,html_body,preview,in_reply_to,references_json,created_at,is_read
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
  `).run(id,threadId,'outbound','queued',input.from,JSON.stringify(input.to),JSON.stringify(input.cc),
    JSON.stringify(input.bcc),'[]',input.subject,input.text,`<div>${escaped}</div>`,previewOf(input.text,null),
    inReplyTo,JSON.stringify(references),createdAt);
  touchThread(threadId,input.subject,createdAt);

  if (input.attachments.length) {
    const dir = path.join(config.dataDir,'attachments',id);
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    for (const a of input.attachments) {
      const bytes = Buffer.from(a.base64,'base64');
      if (bytes.length > config.maxAttachmentBytes) return res.status(413).json({error:`${a.filename} exceeds attachment limit`});
      const safe = a.filename.replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,180);
      const target = path.join(dir,`${newId()}-${safe}`);
      fs.writeFileSync(target,bytes,{mode:0o600});
      db.prepare(`
        INSERT INTO attachments(id,message_id,filename,content_type,size_bytes,local_path,created_at)
        VALUES(?,?,?,?,?,?,?)
      `).run(newId(),id,a.filename,a.contentType,bytes.length,target,now());
    }
  }

  if (input.draftId) db.prepare('DELETE FROM drafts WHERE id=?').run(input.draftId);
  const sentNow = await flushOutbox();
  const saved = db.prepare('SELECT status,last_error FROM messages WHERE id=?').get(id) as any;
  res.status(saved.status === 'sent' ? 201 : 202).json({ id, status:saved.status, sentNow, error:saved.last_error });
});

app.get('/api/attachments/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.id) as any;
  if (!row || !row.local_path || !fs.existsSync(row.local_path)) return res.status(404).json({error:'Attachment is not available locally'});
  res.setHeader('Content-Type', row.content_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${String(row.filename).replace(/"/g,'')}"`);
  fs.createReadStream(row.local_path).pipe(res);
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve('dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { etag:true, maxAge:'1h' }));
    app.get('*', (_req,res) => res.sendFile(path.join(dist,'index.html')));
  }
}

app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({error:'Invalid request',details:error.issues});
  console.error('[gibp-mail]', error);
  res.status(500).json({error:error instanceof Error ? error.message : 'Internal error'});
});

startSyncLoop();
startOutboxLoop();

app.listen(config.port, config.host, () => {
  console.log(`GIBP Mail API listening at http://${config.host}:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
  console.log(config.resendApiKey ? 'Resend configured.' : 'RESEND_API_KEY is missing; local mail remains available.');
});
