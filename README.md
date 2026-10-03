# GIBP Mail

A **local-first email client for Resend**. Resend is the internet-facing mail transport; your PC is the long-term mailbox.

GIBP Mail listens only on `127.0.0.1`, stores messages in SQLite, downloads inbound attachments to the local filesystem, keeps drafts and mailbox state locally, and queues outgoing messages when Resend or the internet is unavailable.

## What is included

- Inbox, Sent, Drafts, Outbox, Starred, Archive and Trash
- Real conversation threading using `Message-ID`, `In-Reply-To` and `References`
- Multiple `gibp.app` / `gibp.global` sending identities
- Background inbound and sent-mail synchronization
- Catch-up sync after the PC has been offline
- SQLite WAL storage and SQLite FTS5 local search
- Local attachment download and serving
- Autosaved drafts
- Offline Outbox with automatic retry
- Idempotent Resend sends
- Responsive three-pane desktop interface and mobile layout
- Sandboxed display of HTML email
- Local-only API key handling
- systemd user service for Garuda/Arch and other systemd Linux distributions

## Architecture

```
Internet
   |
 Resend
   | HTTPS pull/send
   v
GIBP Mail local service
   |-- SQLite: ~/.local/share/gibp-mail/mail.sqlite
   |-- Files:  ~/.local/share/gibp-mail/attachments/
   |
   +-- http://127.0.0.1:8768
```

There is no public webhook endpoint and no cloud database. Resend stores inbound mail on its side; the local sync worker polls its APIs and imports anything not already present locally.

## Requirements

- Linux
- Node.js 22 or newer
- npm
- A Resend API key with the permissions required to send and read emails
- Your receiving domains configured in Resend

The code targets the current Resend APIs for:

- `GET /emails/receiving`
- `GET /emails/receiving/:id`
- `GET /emails/receiving/:id/attachments`
- `GET /emails`
- `GET /emails/:id`
- `POST /emails`

## Recommended installation

Clone the repository and run:

```bash
chmod +x scripts/install-local.sh
./scripts/install-local.sh
```

The installer:

1. installs dependencies;
2. type-checks and builds the UI;
3. creates `~/.config/gibp-mail/mail.env`;
4. creates the local data directory;
5. installs and enables a hardened systemd user service.

Then edit:

```bash
nano ~/.config/gibp-mail/mail.env
```

At minimum set:

```dotenv
RESEND_API_KEY=re_your_key_here

GIBP_MAIL_IDENTITIES=Martin <martin@gibp.global>,Partnerships <partnerships@gibp.global>,Banking <banking@gibp.global>,Compliance <compliance@gibp.global>,Support <support@gibp.app>,Payments <payments@gibp.app>
```

Start it:

```bash
systemctl --user start gibp-mail
systemctl --user status gibp-mail
```

Open:

```
http://127.0.0.1:8768
```

To start the user service even when you are not interactively logged in:

```bash
loginctl enable-linger "$USER"
```

## Development

```bash
cp .env.example .env
nano .env
npm install
npm run dev
```

Open `http://127.0.0.1:8767`. Vite proxies API requests to the local API on port 8768.

Run validation with:

```bash
npm run check
```

## Storage

Default location:

```
~/.local/share/gibp-mail/
├── mail.sqlite
├── mail.sqlite-wal
├── mail.sqlite-shm
└── attachments/
```

The Resend API key is **not** stored in SQLite. The installed service reads it from:

```
~/.config/gibp-mail/mail.env
```

which the installer creates with mode `0600`.

### Backups

The mailbox is intentionally local-first, so back it up. A safe SQLite backup should use SQLite's backup command or copy after stopping the service:

```bash
systemctl --user stop gibp-mail
tar -C "$HOME/.local/share" -czf "gibp-mail-$(date +%F).tar.gz" gibp-mail
systemctl --user start gibp-mail
```

Store encrypted backups on a separate disk.

## Sync behaviour

The worker polls Resend every `GIBP_MAIL_SYNC_SECONDS` (45 seconds by default; minimum 15 seconds).

On first run it paginates through received and sent email history and imports messages it does not already know about. Subsequent passes are idempotent because each Resend provider ID is unique in the local database.

If the PC is off, mail remains at Resend. When GIBP Mail starts again, catch-up sync imports the missed mail.

Outgoing mail is written to SQLite **before** a Resend send is attempted. If the send fails, it stays in Outbox and the local retry worker attempts it again. Each send uses a stable idempotency key derived from the local message ID.

## Threading

Thread matching uses, in order:

1. `In-Reply-To` and `References` against known `Message-ID` values;
2. normalized subject as a fallback for messages where usable reply headers are unavailable.

Replies created in GIBP Mail send `In-Reply-To` and `References` headers so other email clients also group the conversation correctly.

## Security notes

- The HTTP server defaults to `127.0.0.1` only.
- Do not change it to `0.0.0.0` without adding authentication and TLS.
- API credentials never enter browser JavaScript.
- HTML email is rendered inside a sandboxed iframe.
- Attachment filenames are sanitized before local storage.
- The service has systemd hardening and only receives write access to the GIBP Mail data directory.
- Keep full-disk encryption enabled because the SQLite database and downloaded attachments contain readable correspondence.

## Environment options

| Variable | Default | Purpose |
|---|---|---|
| `RESEND_API_KEY` | — | Resend credential |
| `GIBP_MAIL_HOST` | `127.0.0.1` | Local bind address |
| `GIBP_MAIL_PORT` | `8768` | Local production/API port |
| `GIBP_MAIL_DATA_DIR` | `~/.local/share/gibp-mail` | Persistent mailbox storage |
| `GIBP_MAIL_IDENTITIES` | GIBP defaults | Comma-separated From identities |
| `GIBP_MAIL_SYNC_SECONDS` | `45` | Poll interval |
| `GIBP_MAIL_MAX_ATTACHMENT_BYTES` | `26214400` | Per-attachment local download limit |

## Important limitation

This is an API-based mail client, not an IMAP server. Thunderbird/Apple Mail/etc. do not connect to it. The browser UI is the client, the local Node service is the mailbox engine, and Resend is the transport.
