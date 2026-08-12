# Deployment guide

This document is for whoever puts this system online for the first time. It assumes you have this repo checked out, `npm install` done, and no host chosen yet — nothing here names a provider, because the choice hasn't been made. It applies to any host that runs a long-lived Node process (a VM, a container platform, a managed Node/PaaS service) for `apps/api`, and any static/Node host for `apps/web`.

**Per `CLAUDE.md` §5, this document does not deploy anything, and no agent should trigger the first production deploy.** That is a human's call. This is prep.

## What has never been verified

Read this section before anything else. It is the point of this document, not a footnote.

- **The confirmation email has never been sent.** No `RESEND_API_KEY` has ever been configured anywhere in this project's history, so the send path in `apps/api/src/lib/email.ts` (the `fetch` call to `https://api.resend.com/emails`) has never executed once. Only the request shape and the no-key logging fallback (`console.info('[email] would send...')`) are proven to work. A wrong `EMAIL_FROM` domain, an unverified sender, or a malformed request to a real provider would surface for the first time in staging — not before.
- **Nobody has opened the six pages built in Phases 4 and 5 in a browser.** `/me/tickets`, `/me/tickets/[id]`, `/admin`, `/admin/events`, `/admin/events/[id]/showtimes`, `/admin/bookings` — every check on these was made at the HTTP layer with curl against the API. Rendering, layout, client-side fetch wiring, and error states in the actual browser are unverified.
- **No QR code has been scanned with a real camera.** The signing and rendering code is tested; a physical scan of a physical or on-screen code has not happened.

Budget time to check all three manually before or immediately after the first deploy.

## 1. Required environment variables

Mostly derived from `apps/api/src/lib/config.ts`, with two exceptions noted in the table below: `PORT` is read directly in `apps/api/src/index.ts`, and `DATABASE_URL` is read by Prisma via `apps/api/prisma/schema.prisma`, not by `config.ts`. "Boot guard" means `assertPaymentProviderIsSafe()` (called at the top of `apps/api/src/index.ts`) or the top-level check in `config.ts` — both run only when `NODE_ENV=production`, and both `throw`, which crashes the process before it starts listening.

| Variable | What it does | If missing or wrong |
|---|---|---|
| `DATABASE_URL` | Postgres connection string (Prisma) | Prisma throws on first query; the process won't serve anything useful. Not checked by a boot guard — it fails on first DB access, not at startup. |
| `JWT_SECRET` | Signs/verifies session JWTs | **Boot guard.** Missing in production → refuses to start (`JWT_SECRET must be set when NODE_ENV=production`). Set to the exact `.env.example` placeholder (`dev-secret-change-me`) → also refused, since that string is public. Unset in non-production, it silently falls back to that same placeholder. |
| `PAYMENT_WEBHOOK_SECRET` | Verifies the payment provider's webhook signature | **Boot guard**, same two checks as `JWT_SECRET`: missing in production refuses to start, and the placeholder value (`dev-webhook-secret-change-me`) is rejected outright. Wrong-but-set value doesn't crash boot — it just means every real webhook fails signature verification and payments never confirm. |
| `TICKET_SIGNING_SECRET` | Signs the QR payload on issued tickets | **Boot guard**, same pattern: missing or left as the placeholder (`dev-ticket-secret-change-me`) refuses to start in production. |
| `PAYMENT_PROVIDER` | Selects `stripe` (default) or `mock` | **Boot guard.** `mock` in production is refused outright — the mock provider marks any booking PAID with no money involved, so shipping it live is a free-tickets endpoint. Default when unset is `stripe`, not `mock`. |
| `FRONTEND_ORIGIN` | The one origin CORS allows; also the base URL used to build ticket links in confirmation emails | No boot guard. Wrong value: the browser's requests get CORS-rejected (frontend looks completely broken), and/or email ticket links point at the wrong host. Defaults to `http://localhost:3000` if unset — wrong in any real deploy. |
| `REDIS_URL` | Seat-hold storage (Redis) | No boot guard. Wrong or unreachable: seat holds fail, which blocks booking end-to-end. Defaults to `redis://localhost:6379`. |
| `API_BASE_URL` | Where the **mock** provider posts its webhook back to | Only read when `PAYMENT_PROVIDER=mock`. Irrelevant on a real `stripe` deploy. Defaults to `http://localhost:4000`. |
| `RESEND_API_KEY` | Enables sending the confirmation email via Resend's REST API | No boot guard, and unset is a *supported* state: `lib/email.ts` logs what it would have sent instead of sending. See "What has never been verified" above — this path is unproven either way. |
| `EMAIL_FROM` | The `from` address on confirmation emails | Only matters once `RESEND_API_KEY` is set. Defaults to `tickets@example.com`, which will not pass most providers' sender verification. |
| `PORT` | Port the API listens on | Defaults to `4000`. Most PaaS hosts inject this themselves — check the host's convention before hardcoding it. |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Read only by `prisma/seed.ts`, not by the running server | Irrelevant to boot. Only matters if you run the seed script against production, which creates an admin account — see the "refuses to run outside local dev" guard already in that script before you consider it. |

`apps/web` needs its own variable, `NEXT_PUBLIC_API_URL`, set to wherever `apps/api` is reachable. Wrong value: every fetch from the frontend goes to the wrong host or fails outright.

## 2. Variables that need a human decision, not a default

- **`TRUST_PROXY`** — `true` when this process sits behind a reverse proxy (true of most managed platforms, which terminate TLS in front of your process), `false`/unset on a bare VM with nothing in front. Get this wrong either direction and it's a real failure, not a cosmetic one:
  - **Left off behind a proxy:** every request arrives at Express with the proxy's own IP, not the real client's. The login rate limiter (`apps/api/src/lib/rate-limit.ts`) is keyed on `req.ip`, so it becomes one shared bucket — one attacker's 5 failed login attempts locks out *every* user behind that proxy for the 15-minute window.
  - **Turned on with nothing actually proxying:** Express trusts the client-supplied `X-Forwarded-For` header verbatim. Any client can set that header to a fresh value per request and dodge the login rate limiter entirely.
  - `apps/api/src/index.ts` prints a boot-time warning (not a crash) when `NODE_ENV=production` and `TRUST_PROXY` is off, pointing back at this file. It cannot tell which case you're in — only you know whether a proxy actually sits in front.
- **`RESEND_API_KEY`** — unset is valid (emails get logged, not sent); set it once you've chosen and verified a sender domain with Resend. See "What has never been verified."
- **`FRONTEND_ORIGIN`** — must be the exact origin (scheme + host + port) the frontend is actually served from. It's both the sole allowed CORS origin and the base of every ticket link a confirmation email sends, so a mismatch breaks two unrelated things at once.

## 3. Deploy order

1. Set every required environment variable (Section 1) for `apps/api`, with `NODE_ENV=production`.
2. Run `npx prisma migrate deploy` (from `apps/api`, against the production `DATABASE_URL`) to completion **before** shifting any traffic to the new API version.
3. Start/deploy the new `apps/api` version.
4. Deploy the new `apps/web` version, pointed at the new API via `NEXT_PUBLIC_API_URL`.

Every migration currently in `apps/api/prisma/migrations/` is additive (verified below), so the *old* code can keep running against the *new* schema for the window between step 2 and step 3. That's what makes "migrate first, deploy second" safe here — it stops being true the moment any migration drops or renames a column or table the old code still reads.

## 4. Rollback

**Verified fact:** no migration under `apps/api/prisma/migrations/` contains a `DROP` statement (checked with `grep -ril "drop " apps/api/prisma/migrations/`, no matches). That means rolling back a bad deploy is: redeploy the previous `apps/api`/`apps/web` build, and leave the schema exactly where it is — the old code already works against it, by the same additive property Section 3 relies on.

If a specific migration genuinely must be undone:

1. Do **not** edit a migration file that has already been applied to any shared database — Prisma tracks applied migrations by content hash, and editing one after the fact desyncs that history.
2. Mark it as rolled back in Prisma's migration table: `npx prisma migrate resolve --rolled-back <migration-name>`.
3. Write a **new**, forward migration that reverses the change.

## 5. The first production deploy is a human's

`CLAUDE.md` §5 and the project plan both reserve the first production deploy for a human reviewer, not an agent. Nothing in this phase deploys anything — this document exists so that human has what they need when they do it.

## 6. Running the load check

`npm run load:booking` (from the repo root) answers one question: when many people try to grab the same seat at the same instant, does exactly one of them get it?

- **It needs a live API.** Start `apps/api` first (`npm run dev:api`, or point `API_BASE_URL` at a running deployment) — the script is not part of `npm test` and is never run automatically.
- It registers 50 throwaway users against the real `/auth/register` and `/auth/login` endpoints, fires 50 concurrent seat-hold requests at one seat, then counts the actual `BookingSeat` rows for that seat — not just HTTP status codes, since two `201`s racing to write one row (or vice versa) can both look fine at the HTTP layer alone.
- A pass looks like this (actual output from this run, seat count is the number that matters):
  ```
  Load: 50 users contending for one seat against http://localhost:4000

  HTTP results:
    201: 1
    409: 49

  BookingSeat rows for the contended seat: 1
  PASS — exactly one booking holds the seat
  ```
- On the success path, it cleans up everything it creates (scoped by its own run-timestamp). The teardown is plain statements at the end of `main()`, not a `try/finally`, so if the script throws partway through (a failed registration, a dropped connection mid-burst), the cleanup is skipped and that run's venue, event, showtime, seat map, seat, users, and any bookings are stranded in the shared dev Postgres — harmless to other runs (ids are timestamp-stamped) but visible as a leftover `load <stamp> event` in `/events` and `/admin/events`. If a run dies mid-way, delete that run's rows by hand (filter on its `load <stamp>` name/email prefix) rather than leaving them to accumulate. It also measures correctness only — no latency or throughput numbers. That needs a real load-testing tool, which is a new dependency and out of scope until someone asks for a capacity number.

## See also

- `CLAUDE.md` — binding project rules, including what an agent may never do unsupervised.
- `Ticket-Booking-System-Plan.md` — full phase plan.
- `apps/api/.env.example` — the exact variable names and dev placeholders referenced above.
