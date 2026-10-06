import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';

const sqlite = new SQLiteConnection(CapacitorSQLite);
let connection: SQLiteDBConnection | null = null;

function createSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

const schema = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_sync_at TEXT, last_error TEXT
);
CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown', can_send INTEGER NOT NULL DEFAULT 1,
  can_receive INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  UNIQUE(account_id, domain)
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, subject TEXT NOT NULL DEFAULT '', normalized_subject TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  provider_id TEXT, provider_key TEXT UNIQUE, direction TEXT NOT NULL, status TEXT NOT NULL,
  from_address TEXT NOT NULL DEFAULT '', from_name TEXT, to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]', bcc_json TEXT NOT NULL DEFAULT '[]',
  reply_to_json TEXT NOT NULL DEFAULT '[]', subject TEXT NOT NULL DEFAULT '',
  text_body TEXT, html_body TEXT, preview TEXT NOT NULL DEFAULT '', message_id_header TEXT,
  in_reply_to TEXT, references_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  received_at TEXT, sent_at TEXT, is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT, last_error TEXT, revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mobile_messages_thread ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mobile_messages_account_provider ON messages(account_id, provider_id);
CREATE INDEX IF NOT EXISTS idx_mobile_messages_revision ON messages(revision);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, provider_attachment_id TEXT,
  filename TEXT NOT NULL, content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER, local_path TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY, account_id TEXT, reply_to_message_id TEXT,
  from_identity TEXT NOT NULL DEFAULT '', to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]', bcc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '', text_body TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL, created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS suppressions (
  email TEXT PRIMARY KEY, reason TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, account_id TEXT NOT NULL, from_address TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
  max_per_hour INTEGER NOT NULL DEFAULT 25, max_per_day INTEGER NOT NULL DEFAULT 100,
  followup_days INTEGER NOT NULL DEFAULT 3, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaign_contacts (
  id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT, company TEXT,
  context TEXT, state TEXT NOT NULL DEFAULT 'queued', step INTEGER NOT NULL DEFAULT 0,
  next_action_at TEXT, last_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(campaign_id, email)
);
CREATE TABLE IF NOT EXISTS automation_rules (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  account_id TEXT, mode TEXT NOT NULL DEFAULT 'draft', confidence_threshold REAL NOT NULL DEFAULT 0.92,
  categories_json TEXT NOT NULL DEFAULT '[]', max_auto_replies_per_hour INTEGER NOT NULL DEFAULT 10,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS automation_audit (
  id TEXT PRIMARY KEY, message_id TEXT, campaign_id TEXT, action TEXT NOT NULL,
  decision_json TEXT NOT NULL, executed INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS aliases (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  pattern TEXT,
  display_name TEXT,
  signature_id TEXT,
  persona TEXT,
  tone TEXT,
  default_language TEXT NOT NULL DEFAULT 'auto',
  folder TEXT,
  color TEXT,
  notification_priority TEXT NOT NULL DEFAULT 'normal',
  ai_mode TEXT NOT NULL DEFAULT 'inherit',
  glossary_json TEXT NOT NULL DEFAULT '[]',
  forward_to_json TEXT NOT NULL DEFAULT '[]',
  is_dynamic INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aliases_account ON aliases(account_id,address);
CREATE TABLE IF NOT EXISTS signatures (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  text_body TEXT NOT NULL DEFAULT '',
  html_body TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routing_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  conditions_json TEXT NOT NULL DEFAULT '{}',
  actions_json TEXT NOT NULL DEFAULT '{}',
  stop_processing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routing_rules_priority ON routing_rules(enabled,priority);
CREATE TABLE IF NOT EXISTS message_intelligence (
  message_id TEXT PRIMARY KEY,
  alias_id TEXT,
  category TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  needs_reply INTEGER NOT NULL DEFAULT 0,
  needs_me INTEGER NOT NULL DEFAULT 0,
  waiting INTEGER NOT NULL DEFAULT 0,
  language TEXT,
  why_it_matters TEXT,
  summary TEXT,
  actions_json TEXT NOT NULL DEFAULT '[]',
  deadline_at TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  ai_confidence REAL,
  analyzed_at TEXT,
  FOREIGN KEY(message_id) REFERENCES messages(id)
);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  message_id TEXT,
  kind TEXT NOT NULL,
  due_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(state,due_at);
CREATE TABLE IF NOT EXISTS snoozes (
  thread_id TEXT PRIMARY KEY,
  until_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  alias_pattern TEXT,
  language TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduled_sends (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'scheduled',
  undo_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_sends_due ON scheduled_sends(state,scheduled_at);
CREATE TABLE IF NOT EXISTS delivery_events (
  id TEXT PRIMARY KEY,
  provider_event_id TEXT UNIQUE,
  account_id TEXT,
  provider_message_id TEXT,
  local_message_id TEXT,
  event_type TEXT NOT NULL,
  recipient TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_events_message ON delivery_events(local_message_id,occurred_at);
CREATE TABLE IF NOT EXISTS translations (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  draft_id TEXT,
  source_language TEXT,
  target_language TEXT NOT NULL,
  mode TEXT NOT NULL,
  original_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  back_translation TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contact_memory (
  email TEXT PRIMARY KEY,
  name TEXT,
  company TEXT,
  preferred_language TEXT,
  last_thread_id TEXT,
  last_contact_at TEXT,
  notes TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS briefings (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS replica_targets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, token TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, last_revision INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT, last_error TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export async function mobileDb(): Promise<SQLiteDBConnection> {
  if (connection) return connection;
  const stored = await sqlite.isSecretStored();
  if (!stored.result) await sqlite.setEncryptionSecret(createSecret());
  const existing = await sqlite.isConnection('gibp_mail', false);
  connection = existing.result
    ? await sqlite.retrieveConnection('gibp_mail', false)
    : await sqlite.createConnection('gibp_mail', true, 'secret', 1, false);
  await connection.open();
  await connection.execute(schema);
  return connection;
}

export async function all<T = any>(statement: string, values: any[] = []): Promise<T[]> {
  const db = await mobileDb();
  const result = await db.query(statement, values);
  return (result.values || []) as T[];
}
export async function one<T = any>(statement: string, values: any[] = []): Promise<T | null> {
  return (await all<T>(statement, values))[0] || null;
}
export async function run(statement: string, values: any[] = []): Promise<void> {
  const db = await mobileDb();
  await db.run(statement, values);
}
export async function nextRevision(): Promise<number> {
  const row = await one<{ value: string }>('SELECT value FROM settings WHERE key=?', ['revision']);
  const value = Number(row?.value || 0) + 1;
  await run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['revision', String(value)]);
  return value;
}
export function uid(prefix = ''): string { return prefix + crypto.randomUUID(); }
export const isoNow = () => new Date().toISOString();
export function json<T>(value: string | null | undefined, fallback: T): T {
  try { return JSON.parse(value || '') as T; } catch { return fallback; }
}
export function normalizeSubject(subject: string): string {
  return subject.replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
export function messagePreview(text?: string | null, html?: string | null): string {
  const raw = text || (html ? html.replace(/<[^>]+>/g, ' ') : '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 220);
}
