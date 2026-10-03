import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(config.dataDir, 'attachments'), { recursive: true, mode: 0o700 });

export const db = new Database(path.join(config.dataDir, 'mail.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL DEFAULT '',
  normalized_subject TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  provider_id TEXT UNIQUE,
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  status TEXT NOT NULL DEFAULT 'received',
  from_address TEXT NOT NULL DEFAULT '',
  from_name TEXT,
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  reply_to_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  text_body TEXT,
  html_body TEXT,
  preview TEXT NOT NULL DEFAULT '',
  message_id_header TEXT,
  in_reply_to TEXT,
  references_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  received_at TEXT,
  sent_at TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(direction, is_archived, deleted_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(message_id_header);
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(in_reply_to);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  provider_attachment_id TEXT,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER,
  local_path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  reply_to_message_id TEXT,
  from_identity TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED,
  subject,
  from_address,
  recipients,
  body,
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(message_id, subject, from_address, recipients, body)
  VALUES (
    new.id,
    new.subject,
    new.from_address,
    new.to_json || ' ' || new.cc_json,
    coalesce(new.text_body, '') || ' ' || coalesce(new.html_body, '')
  );
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF subject,from_address,to_json,cc_json,text_body,html_body ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts(message_id, subject, from_address, recipients, body)
  VALUES (
    new.id,
    new.subject,
    new.from_address,
    new.to_json || ' ' || new.cc_json,
    coalesce(new.text_body, '') || ' ' || coalesce(new.html_body, '')
  );
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;
`);

export const now = () => new Date().toISOString();
export const newId = () => nanoid();

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, value);
}

export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function previewOf(text?: string | null, html?: string | null): string {
  const source = text || (html ? html.replace(/<[^>]*>/g, ' ') : '');
  return source.replace(/\s+/g, ' ').trim().slice(0, 220);
}

export function resolveThread(input: {
  subject: string;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  createdAt: string;
}): string {
  const refs = [input.inReplyTo, ...(input.references ?? [])].filter(Boolean) as string[];
  if (refs.length) {
    const placeholders = refs.map(() => '?').join(',');
    const hit = db.prepare(`
      SELECT thread_id FROM messages WHERE message_id_header IN (${placeholders})
      ORDER BY created_at DESC LIMIT 1
    `).get(...refs) as { thread_id: string } | undefined;
    if (hit) return hit.thread_id;
  }

  const normalized = normalizeSubject(input.subject);
  if (normalized) {
    const hit = db.prepare(`
      SELECT id FROM threads
      WHERE normalized_subject = ?
      AND updated_at >= datetime(?, '-30 days')
      ORDER BY updated_at DESC LIMIT 1
    `).get(normalized, input.createdAt) as { id: string } | undefined;
    if (hit) return hit.id;
  }

  const id = newId();
  db.prepare('INSERT INTO threads(id,subject,normalized_subject,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(id, input.subject, normalized, input.createdAt, input.createdAt);
  return id;
}

export function touchThread(threadId: string, subject: string, when: string): void {
  db.prepare(`
    UPDATE threads SET
      subject = CASE WHEN subject = '' THEN ? ELSE subject END,
      updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
    WHERE id = ?
  `).run(subject, when, when, threadId);
}
