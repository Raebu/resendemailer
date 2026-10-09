# GIBP Mail

> **Device handoff:** before doing live Android installation/configuration, use [`docs/CODEX_HANDOFF.md`](docs/CODEX_HANDOFF.md). From a fresh clone, `npm run preflight` performs deterministic dependency installs plus the full app/Worker/Android validation and APK checksum pass; `npm run android:install` builds if necessary, then installs and smoke-tests the APK over ADB.


GIBP Mail is a **phone-primary, local-first universal email client for Resend**. Any Resend account/team can be connected to the same GIBP Mail installation through OAuth, while API-key setup remains available for legacy/headless use.

The Android phone is the authoritative mailbox. Resend provides email transport and temporary recovery; the phone stores the durable encrypted mailbox and attachments. A Linux PC can receive an encrypted-network replica whenever it is online, but the PC never needs to run 24/7.

## Architecture

```
                         Internet
                            |
                     +------+------+
                     | Any Resend  |
                     | account/team |
                     +------+------+
                            |
                    HTTPS send / receive
                            |
                 +----------v-----------+
                 |   GIBP Mail Android  |
                 |   AUTHORITATIVE      |
                 |                      |
                 | SQLCipher mailbox    |
                 | local attachments    |
                 | drafts / read state  |
                 | automation / BD      |
                 +-----+-----------+----+
                       |           |
             HTTPS replica         | stateless AI request
                       |           |
              +--------v----+   +--v----------------+
              | Linux PC    |   | GIBP AI Gateway  |
              | local copy  |   | Cloudflare Worker|
              +-------------+   +--------+----------+
                                         |
                                      OpenAI
```

The OpenAI gateway does not hold the mailbox. It receives only the context needed for one decision and returns a constrained structured result.

## Current capabilities

### Mail

- any number of independent Resend accounts/teams
- OAuth-first **Connect Resend** onboarding with PKCE and API-key fallback
- automatic verified-domain discovery/reconciliation for every connected account
- unified Inbox / Sent / Drafts / Outbox / Starred / Archive / Trash
- encrypted Android SQLite database using SQLCipher
- Android app-private local attachment storage
- catch-up synchronization for inbound and sent mail
- offline Outbox with retry
- idempotent Resend sends
- proper `Message-ID`, `In-Reply-To` and `References` threading
- sandboxed HTML email display
- local search
- autosaved drafts
- Android new-mail background checks and notifications using WorkManager
- launch, resume, network-reconnect and foreground synchronization

### Dynamic sender identities

A traditional mailbox does **not** have to be created for every sender address.

Once a domain is verified for sending in one of the connected Resend accounts, Compose accepts any address on that domain, for example:

```
martin@gibp.global
siddhartha-partnership@gibp.global
nepal-corridor@gibp.global
case-1042@gibp.app
```

GIBP Mail discovers the account that owns the verified domain and routes the message through that Resend account.

### Universal Resend accounts

Android **Settings → Resend accounts** can connect any Resend account/team. OAuth is the default path: tap **Connect Resend**, approve access in Resend, and Android returns to GIBP Mail through the private-use callback URI `global.gibp.mail://oauth/resend`.

GIBP Mail requests Resend's `full_access` OAuth scope because a real mailbox needs more than send-only access: it must discover domains and synchronize received and sent email. OAuth authorization uses PKCE. Short-lived access tokens are refreshed automatically, and Resend's rotating refresh token is replaced atomically in the Android-Keystore-backed account store.

Each connected account has separate:

- OAuth authorization (or an optional dedicated API key for legacy/headless setups)
- verified sending/receiving domains
- inbound/sent synchronization
- error state
- background cursor
- provider ID namespace

The provider key is namespaced by local Resend-account ID, so provider IDs from different accounts cannot collide. Every successful sync reconciles the account's Resend domain inventory, so newly added domains become available automatically and removed domains stop appearing as sender identities.

This makes GIBP Mail account-agnostic: it is not tied to GIBP, Raeburn or any particular Resend login. Multiple organisations, client accounts and Resend teams can coexist on the same device while remaining logically isolated.

### AI automation

The optional AI engine supports:

- inbound classification
- reply drafting
- constrained routine auto-replies
- follow-up decisions
- thread-aware actions
- local audit history
- suppression / unsubscribe handling
- escalation to a human

Automation defaults to **Draft only**.

Sensitive categories are never eligible for automatic sending, including:

- legal
- regulatory
- complaints
- payment disputes
- security/privacy
- employment
- medical
- fraud
- contracts

Safe automatic replies require all policy gates to pass, including category allow-list, confidence threshold and hourly limit.

### Business development

GIBP Mail includes local BD campaign state:

- choose any valid dynamic sender address
- campaign objective/context
- contact queue
- personalised OpenAI-generated outreach
- follow-up scheduling
- maximum 25 new automated campaign sends per hour
- daily cap
- suppression list
- immediate stop on detected reply
- immediate stop on unsubscribe/do-not-contact language
- audit record for AI decisions

`WorkManager` also runs the constrained automation engine while the UI is closed. It can process safe auto-replies, reconcile replies/unsubscribes, and advance active BD campaigns from Android-Keystore-encrypted native state. Foreground launch/resume/network sync remains immediate and reconciles that native progress back into SQLCipher so background work cannot be sent twice.

## Android security model

### Mailbox

The Android mailbox is created with `@capacitor-community/sqlite` encryption enabled.

The database contains:

- accounts
- domains
- threads
- messages
- drafts
- campaigns
- suppression state
- automation rules/audit
- replica state

Attachments live in Android app-private storage.

### Background credentials

The native WorkManager worker needs to check Resend and, when enabled, execute constrained AI/BD automation while the WebView is closed.

Resend OAuth access/refresh tokens (or legacy API keys), the AI gateway bearer token, active campaign state, suppressions and the native automation audit used by that worker are stored separately using AES-256-GCM keys created inside **Android Keystore**. OAuth refresh is serialized so a rotating refresh token cannot be consumed concurrently, and the newly returned token pair is persisted before reuse. These secrets are not written into source code, the APK, plain SharedPreferences, the SQL mailbox or the browser bundle.

The worker:

1. runs under Android WorkManager;
2. requires network connectivity;
3. checks all enabled Resend accounts;
4. maintains an account-specific cursor;
5. notifies only for messages newer than that cursor;
6. reconciles campaign replies and unsubscribe language;
7. may auto-reply only when the same hard-coded safe-category/confidence/rate gates pass;
8. processes at most six BD sends per background run and never more than 25 campaign sends globally in an hour;
9. persists campaign steps/follow-up times in encrypted native state;
10. reconciles that state into the encrypted SQLCipher mailbox when the app next wakes.

The first background run establishes the cursor without flooding the device with historic notifications.

Android controls exact execution time. WorkManager's minimum periodic interval is 15 minutes, so this is not represented as an unrealistic 30-second permanent background loop.

## Build the Android app

Requirements:

- Node.js 22+
- Android Studio / Android SDK
- Android 16 / API 36 SDK recommended
- Java 21

Clone:

```bash
git clone https://github.com/Raebu/resendemailer.git
cd resendemailer
npm ci
```

Generate the Android project the first time:

```bash
npm run android:add
```

Build a debug APK:

```bash
npm run android:debug
```

APK output:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

The repository also contains a GitHub Actions Android workflow. Every PR/build branch produces a `gibp-mail-debug-apk` artifact containing both the APK and its SHA-256 checksum when the native build passes.

For the complete deterministic build plus checksum from a fresh clone, run `npm run preflight`. With an authorised USB-debugging device attached, `npm run android:install` builds if necessary, installs the APK, launches `global.gibp.mail`, and checks for an immediate fatal exception.

## First Android setup

Open GIBP Mail and tap **Settings**.

### 1. Connect Resend accounts

For each Resend account/team:

1. optionally enter a human-readable account/company label;
2. tap **Connect Resend**;
3. approve the requested access in the Resend authorization screen;
4. allow Android to return to GIBP Mail;
5. GIBP Mail validates the authorization and discovers the account's domains automatically.

Repeat this for as many Resend accounts/teams as you need. Verified sending domains become available immediately for dynamic From addresses, and future domain additions/removals are reconciled automatically during normal synchronization.

OAuth tokens are not written to the SQL mailbox. The rotating refresh token and short-lived access token live in the Android-Keystore-protected background account store. Disconnecting an OAuth account revokes the Resend grant and removes its secure local credentials.

#### API-key fallback

The Settings screen retains an **API-key fallback** for legacy/headless scenarios. Use a dedicated Resend credential rather than reusing unrelated production credentials. API-key accounts get the same domain routing, mailbox sync, alias, signature and automation behavior as OAuth accounts.

## OpenAI gateway

The OpenAI API key is deliberately **not** shipped inside the Android APK.

An optional stateless Cloudflare Worker is included in:

```
workers/ai-gateway/
```

Deploy:

```bash
cd workers/ai-gateway
npm ci

npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GIBP_AI_GATEWAY_TOKEN

npx wrangler deploy
```

The included Worker defaults to:

```
gpt-5.6-luna
```

The gateway calls the OpenAI Responses API with a strict JSON schema. It rejects unauthenticated requests and sets no mailbox storage.

In GIBP Mail **Settings → AI gateway**, enter:

```
https://<your-worker>.workers.dev
```

and the same `GIBP_AI_GATEWAY_TOKEN`.

Then choose:

- **Off**
- **Draft only** — recommended initial mode
- **Auto-send safe categories**

## Phone → PC replication

The phone assigns monotonically increasing local revisions to mailbox-state changes.

A PC replica asks for nothing from Resend. Instead, when reachable, the phone pushes only records newer than the PC's last acknowledged revision.

This synchronizes local state such as:

- messages
- read/unread
- starred
- archive/trash
- drafts
- attachments

### Configure the PC receiver

Install the normal Linux client:

```bash
git clone https://github.com/Raebu/resendemailer.git
cd resendemailer
chmod +x scripts/install-local.sh
./scripts/install-local.sh
```

Generate a replica secret:

```bash
openssl rand -hex 32
```

Edit:

```bash
nano ~/.config/gibp-mail/mail.env
```

Set:

```dotenv
GIBP_REPLICA_TOKEN=<the-random-value>
```

For a replica-only PC, `RESEND_API_KEY` may be left blank. The desktop service can still retain the legacy direct-Resend mode if you explicitly want it.

Restart:

```bash
systemctl --user restart gibp-mail
```

The receiver remains bound to `127.0.0.1`.

### Private HTTPS access with Tailscale Serve

Do **not** expose the raw Express port publicly.

With Tailscale installed on the PC:

```bash
tailscale serve --bg localhost:8768
```

Tailscale will provide a private HTTPS `.ts.net` address reachable only according to your tailnet access controls.

On Android, add a replica with:

- Name: `Garuda PC`
- URL: the private `https://....ts.net` address
- Token: the same `GIBP_REPLICA_TOKEN`

The phone refuses replica URLs that do not use HTTPS.

## Linux desktop client

The original local client remains available.

```bash
chmod +x scripts/install-local.sh
./scripts/install-local.sh
nano ~/.config/gibp-mail/mail.env
systemctl --user start gibp-mail
```

Open:

```
http://127.0.0.1:8768
```

Desktop storage:

```
~/.local/share/gibp-mail/
├── mail.sqlite
├── mail.sqlite-wal
├── mail.sqlite-shm
└── attachments/
```

## Development

Web/desktop:

```bash
npm ci
npm run dev
```

Open:

```
http://127.0.0.1:8767
```

Validation:

```bash
npm run check
npm run worker:check
```

Full Android preflight:

```bash
npm run preflight
```

Android project refresh:

```bash
npm run android:sync
```

## Tests and CI

`npm run check` performs:

1. strict TypeScript checking;
2. Node policy tests;
3. production Vite build.

GitHub Actions also generates the Capacitor Android project, applies the native WorkManager/Keystore overlay and runs `assembleDebug`.

The policy tests specifically verify:

- dynamic sender domain normalization;
- safe routine replies can pass the auto-send gate;
- sensitive/regulatory mail cannot pass the gate;
- hourly safety limits are enforced.

## Reliability notes

- SQLite on desktop uses WAL mode.
- Android uses an encrypted native SQLite database.
- OAuth account secrets are isolated in the Android Keystore-backed native store; SQL retains only routing metadata.
- Provider IDs are namespaced per Resend account.
- Outgoing messages are stored locally before sending.
- Retries use stable idempotency keys.
- Attachment writes on the desktop replica are temp-file + atomic rename.
- PC replica updates use per-object revision checks.
- Invalid or older replica revisions cannot overwrite newer phone state.
- Resend catch-up remains a recovery mechanism, not the long-term mailbox.
- Back up both the phone and PC copies where appropriate.

## Important operational limits

### Android background execution

Android does not guarantee exact periodic execution. WorkManager provides reliable deferrable work, but the OS chooses the exact execution time and periodic work cannot run more frequently than Android permits.

For that reason:

- new mail is checked in native background work;
- constrained safe auto-replies and active BD campaigns can also run in native background work;
- full mailbox synchronization runs immediately on launch/resume/network recovery;
- the foreground app synchronizes periodically while visible;
- native and foreground campaign/audit/suppression state is reconciled before foreground automation runs, preventing duplicate sends;
- exact execution remains OS-controlled rather than pretending a WebView can run permanently in the background.

### Resend is an API transport

GIBP Mail can connect to any authorised Resend account/team, but it is not an IMAP server. Gmail, Outlook, Thunderbird and Apple Mail do not connect to it. A Resend domain still needs the appropriate sending/receiving configuration in that Resend account before GIBP Mail can use those capabilities.

### Dynamic sender addresses

A From address can be created on the spot only when its domain is verified for sending in a connected Resend account. GIBP Mail checks that relationship before queueing the message.

## Safety defaults for autonomous outreach

The code intentionally includes hard limits that the model cannot override:

- suppressed/unsubscribed contacts are not sent to;
- a reply stops that contact's campaign sequence;
- autonomous campaign generation cannot exceed 25 new sends/hour;
- sensitive inbound categories require human handling;
- the model is instructed not to invent claims, credentials, pricing, relationships or commitments;
- AI decisions are recorded locally in `automation_audit`.

These controls should be kept even if models, prompts or campaign strategies change.

## Repository layout

```
src/
├── client/             shared React UI
├── mobile/             encrypted Android mailbox + OAuth/sync/AI/replication
├── server/             Linux desktop/replica service
└── shared/             shared types, Resend OAuth/PKCE and safety policy

native/android/java/    native Keystore + WorkManager companion
scripts/                Linux/Android setup helpers
workers/ai-gateway/     stateless OpenAI gateway
tests/                  policy tests
.github/workflows/      web/typecheck and Android APK CI
```
