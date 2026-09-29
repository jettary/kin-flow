# AI transaction entry

Open **Add with AI** using the Gemini button next to **Add transaction**. Submit text, pasted and edited SMS text, keyboard dictation, a recorded voice note, or text plus audio. Russian and English, including mixed input, are supported. Review the suggested expenses, income and transfers, edit fields, exclude unwanted cards, then choose **Save all**. Refunds and edits use manual entry.

Limits: 8,000 characters, one recorded clip of up to 60 seconds, and at most 20 suggested operations per request. Images and OS Share integration are not supported. The browser converts recordings to mono 16 kHz PCM WAV; the server validates the format and sample count before contacting Gemini. Microphone access is allowed only for the same origin and requires browser permission and HTTPS (or localhost).

## Deployment

1. Apply `migrations/004_ai_entry.sql` using the existing migration runner before deploying the updated app (`npm run db:migrate`, with the production database connection provided by the deployment environment). Development's embedded database migrates automatically. The migration adds acknowledgement, quota and batch-receipt storage and does not change existing financial records.
2. Set the server-only `GEMINI_API_KEY` in the deployment environment and redeploy. Never prefix it with `NEXT_PUBLIC_`. `.env.example` is reference only and is not part of this change's commits.
3. The default model is `gemini-3.5-flash-lite`. Override with server-only `GEMINI_MODEL` if needed. Google lists support for text/audio and structured outputs, and a free tier. New projects have restricted access to older 2.5 models. Verify the actual project's model access and quotas in AI Studio before release; the application's 1,000-request cap is independent of Google's rate limits.

The existing public `/terms` page describes AI data handling and financial-record limitations. Before first AI use, each user acknowledges a short Google data notice. The acknowledgement is stored against the user, so it is shared across devices. Under unpaid API terms, Google may use inputs/responses to improve products and may have humans review them; users are told not to submit sensitive, confidential or identifying information. Removing KinFlow's copies does not control Google's handling.

## Data and reliability

- Only submitted text/audio, eligible entity names and scope, account currencies, family base currency and family date/timezone are sent. Opaque references replace database IDs. Account/category usage is computed locally and only affects ordering; transaction history, balances, bank metadata and other members' private entities are not sent.
- Inputs and unconfirmed cards remain in memory only. Text/audio are cleared when submitted; no prompts, recordings or unconfirmed drafts are stored in the database, browser storage, application logs or Gemini Files API. The recorded audio preview URL is revoked after use. Confirmed transaction fields follow the existing record/audit lifecycle.
- The monthly cap is **1,000 outbound Gemini attempts across the application's shared database**, not per user or family. An atomic database reservation prevents concurrent instances exceeding the cap. UTC calendar months define reset boundaries. Failed and timed-out attempts consume a reservation, because the provider may already have received them. There are no automatic Gemini retries. Use the same database across application instances if they share this cap.
- Duplicate warnings are computed on the device using visible synchronized/pending entries and earlier included cards. They compare type, date, source account, currency, amount and transfer destination. A warning is a heuristic; the user chooses whether to keep the card.
- Saving a batch uses one database transaction and the existing authorization, currency, ledger and audit rules for every operation. One invalid card rolls back the entire batch. Idempotent batch receipts prevent duplicates after a lost response. Notifications are enqueued once per eligible recipient device for the whole committed batch, using existing event preferences and generic content.
- Offline users can use manual entry. A prepared batch stays in the open dialog until connectivity returns; it is not placed in the per-operation offline queue. An ambiguous save freezes the batch for a safe retry with the same ID and payload, including if reauthentication is needed. Closing/reloading the browser loses unsaved in-memory cards.

## Verification

`npm test` covers access, context minimization, consent, malformed responses, audio bounds, concurrent quota reservations, UTC reset, batch rollback/idempotency, private transfer visibility and notification grouping. `npm run typecheck` and `npm run build` validate integration.

`npx playwright test -c playwright.production.config.ts` runs against the isolated production fixture database. AI response fixtures make browser assertions deterministic; batch saves use the real API and database. Scenarios cover first-use notice, editable cards, duplicate warning/exclusion, mobile widths, accessibility, offline review/manual fallback, a committed request whose response is lost, reauthentication during retry, and actual browser recording through a synthetic microphone. Provider responses are stubbed in automated tests; these tests do not claim speech interpretation accuracy or physical iOS/Android microphone verification.

## Google references

- [Gemini 3.5 Flash-Lite model capabilities](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
- [Pricing and free-tier availability](https://ai.google.dev/gemini-api/docs/pricing)
- [Model access and deprecations](https://ai.google.dev/gemini-api/docs/deprecations)
- [Audio understanding](https://ai.google.dev/gemini-api/docs/audio)
- [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
- [Gemini API terms](https://ai.google.dev/gemini-api/terms)
