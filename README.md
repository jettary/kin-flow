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

No bank integration, export, attachments, recurring transactions, notifications, drag-and-drop or Quick Entry are included.

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

## Operations and deployment boundaries

Cloud resources, OAuth credentials, production domain, backup scheduling and restore drills require the deployment owner’s accounts; they are not provisioned by this repository. Real Google sign-in and physical-device installation need final checks in that environment.

`deletion_log` keeps irreversible deletion markers without the user’s financial payload. Preserve these markers separately from restorable database snapshots and reapply deletions after recovery. Keep backups encrypted and access-controlled. A code rollback does not undo schema migrations or restore data.

The UI paginates transaction synchronization but currently refreshes all visible account/category/budget metadata together. Before using unusually large workspaces, add metadata pagination and measure response size. The app is intended for family-sized workspaces, not bulk accounting imports.

External implementation references: [Next.js App Router](https://nextjs.org/docs/app), [Google’s Node authentication library](https://github.com/googleapis/google-auth-library-nodejs), [Frankfurter rates and provider terms](https://frankfurter.dev/), [PGlite test adapter](https://pglite.dev/docs/).
