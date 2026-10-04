import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const raw = z.object({
  RESEND_API_KEY: z.string().min(1).optional(),
  GIBP_MAIL_HOST: z.string().default('127.0.0.1'),
  GIBP_MAIL_PORT: z.coerce.number().int().positive().default(8768),
  GIBP_MAIL_DATA_DIR: z.string().default('~/.local/share/gibp-mail'),
  GIBP_MAIL_IDENTITIES: z.string().default('GIBP <hello@gibp.app>,GIBP Global <hello@gibp.global>'),
  GIBP_MAIL_SYNC_SECONDS: z.coerce.number().int().default(45),
  GIBP_MAIL_MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(26_214_400),
  GIBP_REPLICA_TOKEN: z.string().min(24).optional(),
}).parse(process.env);

const expandHome = (p: string) => p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;

export const config = {
  resendApiKey: raw.RESEND_API_KEY ?? '',
  host: raw.GIBP_MAIL_HOST,
  port: raw.GIBP_MAIL_PORT,
  dataDir: expandHome(raw.GIBP_MAIL_DATA_DIR),
  syncSeconds: Math.max(15, raw.GIBP_MAIL_SYNC_SECONDS),
  maxAttachmentBytes: raw.GIBP_MAIL_MAX_ATTACHMENT_BYTES,
  identitiesRaw: raw.GIBP_MAIL_IDENTITIES,
  replicaToken: raw.GIBP_REPLICA_TOKEN ?? '',
};
