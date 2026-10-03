export type Folder = 'inbox' | 'sent' | 'drafts' | 'outbox' | 'archive' | 'trash' | 'starred';

export interface Identity {
  name: string;
  address: string;
  formatted: string;
}

export interface MessageSummary {
  id: string;
  threadId: string;
  providerId: string | null;
  direction: 'inbound' | 'outbound';
  status: string;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  preview: string;
  createdAt: string;
  receivedAt: string | null;
  sentAt: string | null;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  deletedAt: string | null;
  attachmentCount: number;
  threadCount: number;
}

export interface Attachment {
  id: string;
  messageId: string;
  providerAttachmentId: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number | null;
  localPath: string | null;
}

export interface MessageDetail extends MessageSummary {
  bccAddresses: string[];
  replyToAddresses: string[];
  textBody: string | null;
  htmlBody: string | null;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  attachments: Attachment[];
}

export interface ThreadDetail {
  id: string;
  subject: string;
  messages: MessageDetail[];
}

export interface Status {
  configured: boolean;
  syncing: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  dataDir: string;
  queued: number;
}
