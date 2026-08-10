# Phase 1 hardening report

Branch: `phase1-hardening` (based on `9b57b00`)

## Item 1 — Rate limit `/auth/login`

**Files:** `apps/api/src/lib/rate-limit.ts` (new), `apps/api/src/lib/config.ts`, `apps/api/src/routes/auth.ts`, `tests/unit/api/rate-limit.test.ts` (new), `tests/unit/api/auth-routes.test.ts`.

Added a fixed-window in-memory limiter: a `Map<string, { count, windowStart }>` keyed by client IP. `isRateLimited(key)` checks (and sweeps expired entries — an O(n) scan over the map on every call, no timer/interval); `recordLoginFailure(key)` increments. `resetRateLimitState()` is exported purely for test isolation.

Constants added to `config.ts`:
- `LOGIN_RATE_LIMIT_MAX = 10`
- `LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000` (15 min)

Chosen as generous enough that a human mistyping a password a few times never gets blocked, but tight enough to make online password guessing impractical (10 guesses / 15 min ≈ 960/day, far below what's needed to brute-force even a weak password, and it resets the clock on every window boundary rather than banning outright).

**Counting decision (failures vs. all attempts):** the limiter counts only *failed* login attempts (`InvalidCredentialsError`), not every request. Reasoning:
- The threat being defended against is password guessing — every guess in a guessing attack is, by definition, a failure until the last one. Counting only failures still catches every brute-force pattern.
- Counting *all* attempts would also throttle a legitimate user who logs in successfully many times in a row (multiple tabs/devices, or many people behind one office NAT/IP) — a real cost with no security upside, since a correct password already proves the requester isn't guessing.
- Concretely: `isRateLimited(key)` is checked *before* attempting the login (rejects with 429 without even hitting `loginUser`), and `recordLoginFailure(key)` is called only in the `InvalidCredentialsError` branch of the catch block. A success path never touches the counter.

This is exactly what the "does not consume budget on success" test in `auth-routes.test.ts` verifies (loops `LOGIN_RATE_LIMIT_MAX + 5` successful logins and asserts none ever 429).

**Applied to `/auth/login` only** — `/auth/register` and the events routes are untouched, per the task.

**LIMITATION comment** (in `rate-limit.ts`, on `recordLoginFailure`): keying on `req.ip` only reflects the real client when Express's `trust proxy` is enabled (it isn't), so behind a reverse proxy in production every request would arrive as the proxy's IP and share one bucket. The `Map` is also in-memory only — state is lost on restart and not shared across multiple API instances. Both are acceptable for a single-instance Phase 1 deploy; the noted upgrade path is Redis, already planned for Phase 2 seat locks.

**Response on 429:** `{"error": "Too many login attempts. Please try again later."}` — generic, no remaining-attempts count, consistent with the existing error shape used elsewhere in `auth.ts`.

**Tests added:**
- `tests/unit/api/rate-limit.test.ts` — unit-tests the lib directly: under-limit allowed, at-limit blocked, keys tracked independently, and a fake-timers test proving a window reset clears a key (this is also the test that shows the Map doesn't grow forever — an expired entry disappears from `isRateLimited`'s perspective and a fresh failure after expiry starts a new window rather than reusing/inflating the old one).
- `tests/unit/api/auth-routes.test.ts` — three new integration-style tests against the exported `loginHandler` (mocking `loginUser`, same pattern as the existing `registerHandler` test): failures 1..MAX get 401 and MAX+1 gets 429 (and asserts `loginUser` was only called MAX times — proves the 429 short-circuits before ever calling the DB layer); a success-flood test proving budget isn't consumed on success; and an independent-IPs test proving one attacker's lockout doesn't affect another IP.

Self-check: deleting the `isRateLimited` check (or the `recordLoginFailure` call) makes the "401 then 429" test fail immediately, since `loginUser` is mocked to always reject — without the limiter every attempt would just keep returning 401 forever.

## Item 2 — Accessible labels on auth forms

**Files:** `apps/web/app/login/page.tsx`, `apps/web/app/register/page.tsx`.

Added a `<label htmlFor="…">` + matching `id` on every input on both pages (login: email, password; register: name, email, password). Wrapped each label/input pair in a `flex flex-col gap-1` div so the existing `flex flex-col gap-3` form spacing between fields is preserved visually.

**Kept the placeholders** alongside the new labels — the label already fixes the actual accessibility problem (screen reader announcement, text that doesn't vanish on focus), and keeping the placeholder costs nothing and preserves the existing visual look exactly, per "keep the Tailwind styling consistent... do not restyle." No shared form component was introduced.

## Item 3 — Unchecked cast on event detail page

**File:** `apps/web/app/events/[id]/page.tsx`.

`fetchEvent` now checks that `data.event` is a non-null object before casting; if not, it throws (rather than the list page's pattern of returning `null`). This distinction is deliberate: on this page `null` is already overloaded to mean "genuine 404 → call `notFound()`" (set by the earlier `if (res.status === 404) return null`), so a malformed-200-body case returning `null` would incorrectly reach `notFound()` instead of the Thai error message. Throwing routes it into the existing `catch` block in the page component, which is exactly the "error path" the task asked for. All three outcomes remain distinct:
- Real backend 404 → `fetchEvent` returns `null` → `notFound()`.
- Non-2xx or malformed 200 body → `fetchEvent` throws → caught → Thai error message rendered.
- Well-formed 200 → renders normally.

## Item 4 — Raw error logging in events routes

**Files:** `apps/api/src/lib/log.ts` (new), `apps/api/src/routes/auth.ts`, `apps/api/src/routes/events.ts`.

Moved `logServerError` (previously private to `auth.ts`) into `apps/api/src/lib/log.ts` unchanged, since it's shared business-adjacent code per the project's `/lib` convention. Both `auth.ts`'s two 500 handlers and `events.ts`'s two 500 handlers (`GET /events`, `GET /events/:id`) now import and call it instead of `console.error(err)` / the old local copy. Logging is preserved, just narrowed to `{ code, message }` instead of the whole error object.

## Verification

### `npm run build` (clean, both workspaces)

```
> build
> npm run build --workspaces --if-present

> @ticket-booking/api@0.1.0 build
> prisma generate && tsc

✔ Generated Prisma Client (v6.19.3) to ./node_modules/@prisma/client in 57ms

> @ticket-booking/web@0.1.0 build
> next build

▲ Next.js 16.3.0 (Turbopack)
✓ Compiled successfully in 596ms
  Running TypeScript ...
  Finished TypeScript in 289ms ...
  Collecting page data using 7 workers ...
  Generating static pages using 7 workers (6/6) in 118ms
  Finalizing page optimization ...

Route (app)
┌ ○ /
├ ○ /_not-found
├ ƒ /events
├ ƒ /events/[id]
├ ○ /login
└ ○ /register
```

### `npm test` (11 existing + 7 new = 18, all pass)

```
> test
> npm run test --workspaces --if-present

> @ticket-booking/api@0.1.0 test
> vitest run

 RUN  v4.1.10 /Users/por_surarat/Desktop/ticket-booking-system/apps/api

 Test Files  4 passed (4)
      Tests  18 passed (18)
   Start at  20:41:56
   Duration  504ms (transform 188ms, setup 0ms, import 512ms, tests 307ms, environment 0ms)
```

(`apps/web` has no `test` script, so `--if-present` skips it — pre-existing, unrelated to this change.)

### Live rate-limiter check against the running API (Postgres in Docker, real DB path)

Started the server (`npx tsx src/index.ts`), then hit `/auth/login` with a wrong password 13 times in a row (limit = 10):

```
attempt 1 -> 401
attempt 2 -> 401
attempt 3 -> 401
attempt 4 -> 401
attempt 5 -> 401
attempt 6 -> 401
attempt 7 -> 401
attempt 8 -> 401
attempt 9 -> 401
attempt 10 -> 401
attempt 11 -> 429
attempt 12 -> 429
attempt 13 -> 429
```

Body on the blocked attempt:
```
{"error":"Too many login attempts. Please try again later."}
```

Server was killed afterward (`lsof -ti:4000 | xargs kill -9`).

## Self-review checklist

- Limiter's `Map` is pruned: `sweep()` runs on every `isRateLimited` call and deletes any entry whose window has elapsed — verified by the fake-timers test in `rate-limit.test.ts`.
- Rate-limit test would fail if the check were deleted: yes — with `loginUser` mocked to always reject, removing the `isRateLimited`/`recordLoginFailure` calls means every attempt keeps returning 401, so the "…then 429" assertion fails.
- Every input on both auth pages has a label associated via matching `id`/`htmlFor` (not just visual wrapping) — 2 on login, 3 on register.
- Item 3: a genuine 404 still returns `null` from `fetchEvent` (unchanged code path) and still reaches `notFound()`; only the malformed-200 case was changed to throw.
- No middleware framework, no per-route rate-limit config system, no shared form component, no new dependency — the limiter is ~50 lines in one file, reused directly in the one route that needed it.

## What was skipped on purpose

- No `X-Forwarded-For` handling / `trust proxy` support — flagged as a `LIMITATION` since this deploys as a single instance without a reverse proxy yet.
- No Redis-backed limiter — Phase 2 concern per the plan; the in-memory version is correct and sufficient for Phase 1's single-instance deployment.
- Placeholders were kept rather than removed — a judgment call, not a correctness gap.

## Needs review

- The `LOGIN_RATE_LIMIT_MAX`/`WINDOW_MS` values (10 / 15 min) are my best judgment for "sane defaults"; please confirm they match any product/security expectation you have in mind before this goes further.
