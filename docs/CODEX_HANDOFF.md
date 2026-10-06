# Codex Handoff — GIBP Mail

This document is the operational handoff for finishing and installing GIBP Mail after the repository hardening pass.

## What is already complete

The repository already contains and CI-validates:

- phone-primary Android architecture
- encrypted SQLCipher mailbox
- Android app-private attachment storage
- multiple Resend accounts
- verified-domain discovery
- dynamic From addresses
- inbound/sent catch-up sync
- threaded conversations
- offline Outbox
- deterministic idempotency identities for automated replies and BD steps
- WorkManager background checks
- Keystore-encrypted background credentials/state
- native notifications
- safe AI auto-response policy gates
- autonomous BD campaigns
- reply/unsubscribe stop logic
- global 25 campaign sends/hour limit
- maximum 6 campaign sends per WorkManager run
- phone → PC replication
- stateless OpenAI gateway
- TypeScript/tests/Vite CI
- native Android `assembleDebug` CI

Do not replace this architecture simply to make setup easier.

## Dependency state

Both dependency graphs are already locked:

- root application: `package-lock.json`
- AI gateway: `workers/ai-gateway/package-lock.json`

Direct root dependencies are also pinned to exact versions.

Do not regenerate or upgrade these merely because newer packages exist. Change dependency versions only to solve a demonstrated build, security or runtime issue.

## One-command preflight

From a fresh clone:

```bash
npm run preflight
```

The preflight command performs deterministic `npm ci` installs itself.

This performs:

1. deterministic root `npm ci`
2. TypeScript validation
3. unit/regression tests
4. production Vite build
5. key-shaped secret scan
6. deterministic AI-gateway `npm ci`
7. Wrangler `deploy --dry-run` bundle validation
8. Capacitor Android generation/sync
9. native overlay application
10. clean Gradle `assembleDebug`
11. APK existence validation
12. SHA-256 generation

Expected APK:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

Expected checksum file:

```
android/app/build/outputs/apk/debug/app-debug.apk.sha256
```

## Install directly onto Android

Connect the phone by USB, enable USB debugging and accept the RSA prompt.

Check:

```bash
adb devices -l
```

Then:

```bash
npm run android:install
```

The installer:

- requires an authorised device
- refuses to guess when multiple devices are attached
- supports `ANDROID_SERIAL`
- installs with `adb install -r`
- launches `global.gibp.mail`
- confirms a process exists
- checks the app process log for an immediate fatal exception

To build and install in one pass:

```bash
INSTALL_TO_PHONE=1 npm run preflight
```

## Multi-account live test

Use dedicated Resend credentials rather than unrelated broad production credentials where practical.

For each Resend account:

1. open GIBP Mail Settings
2. add account name
3. enter Resend API key
4. verify domain count is returned
5. confirm at least one verified sending domain
6. perform manual sync
7. send a controlled test email
8. reply to the test address
9. verify inbound catch-up and thread grouping
10. restart the app and confirm mailbox reopens

Never print API credentials into terminal logs or commit them.

## Dynamic From test

For a verified domain, test an address that was not pre-created as a conventional mailbox, for example:

```
codex-test-<date>@verified-domain
```

Confirm:

- the app accepts it
- it routes through the account owning that verified domain
- a domain owned by no connected account is rejected
- a reply defaults to the address that actually received the inbound message

## SQLCipher runtime test

This must be tested on the real phone, not inferred from compilation.

1. add a Resend account or create local state
2. fully kill GIBP Mail
3. reopen it
4. confirm the encrypted database opens
5. reboot the phone
6. reopen it
7. confirm data remains accessible
8. check logcat for SQLCipher/secret-store errors

Do not clear app storage during this test.

## Background WorkManager test

After configuring a Resend account:

1. grant notification permission
2. open the app once so background state is configured
3. close the UI
4. inspect WorkManager scheduling if needed via Android tooling
5. send a controlled inbound test message
6. allow Android background cadence to run
7. verify notification behavior
8. reopen the app and confirm full mailbox catch-up

Do not expect exact 30-second background timing. Android controls periodic WorkManager execution and the design respects that constraint.

## OpenAI gateway

The gateway source is:

```
workers/ai-gateway/
```

Required secrets:

```bash
cd workers/ai-gateway
npm ci
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GIBP_AI_GATEWAY_TOKEN
npx wrangler deploy
```

Do not put either secret into source, `.env.example`, the APK, or Git history.

After deployment:

1. enter Worker HTTPS URL in GIBP Mail Settings
2. enter the matching gateway bearer token
3. begin in **Draft only**
4. test a routine inbound message
5. confirm an audit entry is created
6. test a sensitive category such as a regulatory query
7. confirm it is never auto-sent
8. only then consider **Auto-send safe categories**

The gateway uses Structured Outputs and requests `store: false`.

## BD validation

Use only controlled test contacts initially.

Verify:

- first outreach
- follow-up step 2
- final step 3
- no step 4
- deterministic idempotency for campaign/contact/step
- reply stops sequence
- unsubscribe language adds suppression
- suppressed contacts cannot be sent to
- global rolling hourly cap never exceeds 25 across campaigns and foreground/background engines
- native worker does not send more than 6 BD messages in one run
- foreground/native state reconciles after reopening the app

Do not weaken these limits to make tests easier.

## PC replica

If required, configure the Linux PC using the README.

The raw Express service remains localhost-only.

Expose privately using HTTPS, for example Tailscale Serve, and configure the same replica bearer token on the phone.

Test:

- new message replication
- read/unread changes
- star/archive/trash
- drafts
- attachment copy
- reconnect after PC was offline

The phone remains authoritative.

## Release signing

A debug APK is enough for device validation.

Do not commit Android signing keys.

After debug runtime validation, optionally prepare a signed release APK/AAB using a keystore that exists securely outside Git. Document the keystore path/alias and inject passwords through environment variables or a secure secrets store.

## Known items that still require a real device/account

The following cannot be truthfully considered complete until executed with actual credentials/hardware:

- live Resend send/receive
- Android database reopen after process kill/reboot
- notification delivery on the target phone
- WorkManager timing on the target phone/OEM
- OpenAI Worker deployment with real secrets
- AI live response
- real ADB installation/launch
- signed release build
- end-to-end phone → PC private-network replication

Everything else should be treated as existing implementation to validate, not as a prompt to rewrite the application.

## Final acceptance commands

Before reporting completion:

```bash
git status
npm run security:scan
npm run check
npm run preflight
adb devices -l
npm run android:install
```

Then report:

- commit SHA
- APK path
- APK size
- APK SHA-256
- Android serial/model used
- package installed
- launch result
- immediate logcat result
- Resend live-test result
- SQLCipher reopen result
- WorkManager result
- AI gateway URL/deployment result
- AI safe/sensitive test result
- BD stop/rate-limit test result
- remaining limitations
