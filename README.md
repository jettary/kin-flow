# KinFlow

Mobile-first family finance PWA, implementing `requirements.md` and the selected **Calm** design. The interface is English. The original planning documents are preserved.

Русская пошаговая настройка Google OAuth, Neon и Vercel: [SETUP_GOOGLE_VERCEL_RU.md](SETUP_GOOGLE_VERCEL_RU.md).

## Run locally

Requires Node.js 24 and npm.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:3000**. Choose **Explore with sample data** to create a separate local sample family. Development uses embedded PostgreSQL in `.local/postgres`, so Docker and cloud accounts are not required. Every demo login creates an isolated family; demo authentication is disabled in production and on Vercel. To disable it locally, set `DEMO_MODE=false`.

For real Google authentication, copy `.env.example` to `.env.local`, configure the Google OAuth web client, and set the exact redirect URL to `http://127.0.0.1:3000/api/auth/callback`. `APP_URL` must match the address opened in your browser.

To develop against a conventional PostgreSQL server instead:

```sh
docker compose up -d
```

Set `DATABASE_URL=postgresql://kinflow:local-development-only@127.0.0.1:5432/kinflow`, run `npm run db:migrate`, then start the application. Migration scripts read shell environment variables; use `node --env-file=.env.local --import tsx scripts/migrate.ts` to load the local environment file explicitly. The Next.js development server loads `.env.local` itself.

## Implemented workflows

- Google sign-in with PKCE, state and nonce verification, verified ID tokens, and revocable server-side sessions in HttpOnly cookies.
- Multiple families, create/join onboarding, expiring limited-use invitations, member/admin/owner roles and ownership transfer.
- Shared and personal accounts, categories and income sources; account opening balances, archiving, ordering with buttons, and inclusion in available balance.
- Amount-first expenses, income, currency exchange, shared ↔ own-personal transfers, balance adjustments with reasons, edits, deletion, and linked full/partial refunds.
- Decimal arithmetic and PostgreSQL numeric ledger entries. Transfers, opening balances and adjustments are excluded from income/expense reports. Refunds reduce spending in their actual receipt month.
- Family-scoped authorization on the server. Private records are excluded from another member’s accounts, reports, search, tags and audits. Mixed transfers and shared-source private income have redacted occurrence notices.
- Current balances, full-width budget pace, effective-dated budgets, monthly history and filters, category/tag analytics, matching-period comparisons, and averages over completed tracked months.
- Daily cached rates, persisted reporting snapshots, manual conversion when a quote is unavailable, and editable actual received/debited amounts.
- PWA manifest, install icons, public shell caching, user/family-scoped IndexedDB data, ordered transaction queue, automatic synchronization, mutation deduplication, cursor-based transaction pages, and conflict audits.
- Permanent personal-data deletion on departure, anonymized shared authorship, preserved shared ledger effects, family/account deletion restrictions, and local cache cleanup on sign-out.
- Responsive sidebar/bottom navigation, light/dark/system appearance, date format preferences, native keyboard-accessible dialogs and reduced-motion support.

- Opt-in Web Push for shared family transactions, per-member/per-family event preferences, independent device subscriptions, generic lock-screen messages, shared-history links, foreground refresh and a durable delivery queue.

No bank integration, export, attachments, recurring transactions, budget/email notifications, drag-and-drop or Quick Entry are included.

## Project structure

| Location                         | Responsibility                                                |
| -------------------------------- | ------------------------------------------------------------- |
| `src/components/`                | Application screens, forms, synchronization controller        |
| `src/lib/`                       | Shared types, decimal money, analytics, IndexedDB persistence |
| `src/server/service.ts`          | Authorization, atomic financial operations, family lifecycle  |
| `src/server/auth.ts`             | Google OAuth and sessions                                     |
| `src/server/rates.ts`            | Shared daily exchange-rate cache and refresh lease            |
| `src/server/db.ts`               | PostgreSQL pool, development adapter, migration runner        |
| `src/app/api/[...path]/route.ts` | Same-origin authenticated HTTP API                            |
| `migrations/`                    | Ordered, transactional schema migrations                      |
| `public/sw.js`                   | Public shell/static-asset caching; never caches API responses |
| `tests/`                         | Financial/security regression tests and browser scenarios     |

Each financial mutation locks its family row and commits the transaction, ledger legs, audit and idempotency receipt together. Money enters the API as decimal strings. Visibility is derived from referenced accounts/categories, never trusted from a transaction request. The application database role enforces isolation through the service layer; this implementation does not claim database RLS protection.

Rate snapshots retain the values used for reports. The browser supplies the identifier of its previously received snapshot for offline-created operations; the server resolves it from persisted snapshots. Missing quotes are shown explicitly. Budget equivalents and current holdings use current available rates; recorded transaction conversions remain fixed.

Sync pages contain at most 150 transactions. Each page uses a server version watermark and filters private records before serialization. Account/category metadata and balances are refreshed with the snapshot. Soft-deleted transactions are tombstones. A rejected or expired session keeps pending work; known loss of membership clears that family’s local data. An offline device cannot learn about membership changes until it reconnects. Closed PWAs do not guarantee background synchronization.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:production
```

`test:e2e` starts the development app and uses the local demo login. `test:production` builds the real application and starts an isolated in-memory PostgreSQL protocol server plus the production web server. It injects a synthetic test session from the test harness; there is **no production authentication bypass** in the app. The production scenario verifies creating/editing expenses, actual currency-exchange amounts, offline creation/editing/reload and reconnection, desktop/mobile navigation, dark appearance, accessibility, and cache cleanup across open tabs (including a delayed sign-in-state response after sign-out).

Browser tests default to an installed Google Chrome. On CI, set `PLAYWRIGHT_CHANNEL=chromium` and run `npx playwright install --with-deps chromium`. Screenshots and traces are written to `test-results/` and are not source files.

Use a production build for offline reload tests. The Next.js development runtime relies on its live development connection and is unsuitable for validating offline startup.

## Deploy to Vercel + Neon

1. Create separate development/preview/production PostgreSQL databases. Preview data must be synthetic. Select a European database region close to Vercel `fra1` (configured in `vercel.json`).
2. Create a Google OAuth web client with exact authorized origins and callback `https://YOUR_DOMAIN/api/auth/callback`. Use a separate client and a stable hostname for staging.
3. Set production environment variables on Vercel: `DATABASE_URL`, `APP_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CRON_SECRET`. Set `APP_URL` to the canonical HTTPS origin without a trailing slash. Do not prefix secrets with `NEXT_PUBLIC_`.
4. Use a pooled PostgreSQL runtime connection with TLS as required by Neon. Store a direct migration connection as `MIGRATION_DATABASE_URL` only in the controlled release job. Runtime needs table DML permissions, not schema-owner privileges.
5. Run `npm ci`, checks and `npm run db:migrate` once in the release step. The application never runs production migrations on startup or during preview builds. Build command: `npm run build`; framework: Next.js; Node.js: 24.
6. Deploy the project. `vercel.json` configures a protected daily `/api/cron/rates` invocation. The handler expects `Authorization: Bearer CRON_SECRET`; ordinary sync also attempts a rate refresh after 24 hours, protected by a database lease and a five-minute retry delay.
7. Complete a real Google login and test create/join family, cross-user privacy, transfer, refund, offline sync, sign-out, and installation on actual iOS/Android browsers.
8. Configure provider backups, error/availability monitoring, database quota alerts, and rate freshness monitoring. Perform a restore into an isolated database and validate permissions and ledger totals before storing important records.

Production does not fall back to embedded storage. A missing `DATABASE_URL` is a configuration error. Local sample data is never automatically added to a deployed database.

## Push notifications

Run migration `003_push_notifications.sql` before deploying this feature. Then configure these server environment variables (none uses `NEXT_PUBLIC_`):

| Variable            | Value                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`  | Application-owned URL-safe public key; exposed through the authenticated notification settings API. |
| `VAPID_PRIVATE_KEY` | Matching private key, held only by the server.                                                      |
| `VAPID_SUBJECT`     | An application-owner contact such as `mailto:you@example.com` or a public HTTPS URL.                |
| `CRON_SECRET`       | Secret bearer token for `/api/cron/push`, shared with the existing rates cron.                      |

Generate the pair **once**, store it in the deployment's secret manager, and keep the same keys across releases:

```sh
npx web-push generate-vapid-keys --json
```

No Firebase account or paid push provider is required. Use separate keys for production and test environments. Do not commit keys or subscription endpoints. Missing VAPID configuration leaves financial workflows and event preferences available, with device opt-in disabled in the UI. After intentional key rotation, disable and re-enable notifications on each device.

Users opt in through **More → Notifications → Enable notifications**. Permission is requested only from this button. New shared purchases default to on; purchase edits/deletions/refunds, transfers/exchanges, and income default to off. Choices belong to the member within the selected family. Disabling a device leaves other devices and family preferences intact. Browser or OS permission revocation may require re-enabling through settings. Subscriptions are tied to the authenticated session: sign-out removes that session's subscriptions; after session expiry and a new sign-in, the user enables the device again. User/family departure deletes pending deliveries through membership references. A maximum of 20 devices is allowed per user.

The server queues notifications in the same transaction as the ledger and idempotency receipt. It sends after commit using Next.js `after()`, never from the browser's optimistic save. Offline mutations use the same path when synced. Only other current family members with matching preferences and active device sessions are eligible; private operations and balance adjustments are excluded. Mixed transfers and shared-source private income can produce only a generic notice. Payloads contain an opaque family ID, delivery ID and one of the two required generic Russian titles; the settings UI remains English. The queue accepts a list of events so a future atomic AI batch can produce one delivery per recipient device, but this does not add AI entry.

Delivery runs immediately after mutations, during ordinary sync/foreground polling, and from the protected `GET /api/cron/push` endpoint. One invocation handles up to 100 messages in pages of 20, with a 60-second route limit, 10-second provider timeout and renewable-on-retry job leases. Network/provider failures retry with exponential delays from 30 seconds up to one hour; pending messages expire after 24 hours. HTTP 404/410 deletes the expired subscription. Membership, preferences, session and foreground status are rechecked before sending. Mutation retries and concurrent workers are deduplicated; a process crash after provider acceptance but before recording success can still repeat a delivery. The stable notification tag limits duplicate visible entries. This is best-effort delivery, not an exactly-once guarantee.

**For retries while all apps are closed, configure an external scheduler to call `/api/cron/push` every minute with `Authorization: Bearer <CRON_SECRET>`.** On a Vercel plan supporting minute-level cron, add `{ "path": "/api/cron/push", "schedule": "* * * * *" }` to the `crons` list in `vercel.json`. The checked-in configuration retains its daily schedule for Hobby compatibility; the existing daily rates cron also attempts queue cleanup/delivery. Without a frequent scheduler, failures retry on the next app request or daily run, so unattended timely retries are not guaranteed. See [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing). Monitor pending outbox age/attempt counts and scheduler failures without logging payloads, endpoints or keys.

A visible subscribed device reports presence and checks family versions every five seconds; changed active history then synchronizes. Presence is tracked per tab and expires after 20 seconds if a browser disappears. Other devices still receive notifications. The service worker also suppresses a late push if a window became visible after dispatch. Browser visibility, network delivery and tab closure can race: stale presence may suppress a notification for up to 20 seconds, and an already accepted provider message cannot be recalled. Safari requires a visible notification for a received Web Push, so repeated last-moment suppression may affect its subscription; server-side presence avoids this in the normal foreground path. These races need real-device validation. See [WebKit's delivery requirements](https://webkit.org/blog/12945/meet-web-push/) and [iPhone/iPad Home Screen support](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

Before release, verify on installed iPhone/iPad, Android and desktop PWAs over HTTPS: explicit opt-in, a second member's shared purchase while closed, foreground refresh without a banner, two devices with one disabled, all four preferences in two families, private operations, offline creation followed by sync, click-through to shared history, and session/membership removal. Automated tests cover event selection, outbox rollback and deduplication, recipient isolation, leases/retries, session/device cleanup, worker events, real API opt-in with a simulated native PushManager, accessibility and responsive settings. They do not claim real APNs/FCM/Firefox delivery or physical-device coverage.

## Operations and deployment boundaries

Cloud resources, OAuth credentials, production domain, backup scheduling and restore drills require the deployment owner’s accounts; they are not provisioned by this repository. Real Google sign-in and physical-device installation need final checks in that environment.

`deletion_log` keeps irreversible deletion markers without the user’s financial payload. Preserve these markers separately from restorable database snapshots and reapply deletions after recovery. Keep backups encrypted and access-controlled. A code rollback does not undo schema migrations or restore data.

The UI paginates transaction synchronization but currently refreshes all visible account/category/budget metadata together. Before using unusually large workspaces, add metadata pagination and measure response size. The app is intended for family-sized workspaces, not bulk accounting imports.

External implementation references: [Next.js App Router](https://nextjs.org/docs/app), [Google’s Node authentication library](https://github.com/googleapis/google-auth-library-nodejs), [Frankfurter rates and provider terms](https://frankfurter.dev/), [PGlite test adapter](https://pglite.dev/docs/).
