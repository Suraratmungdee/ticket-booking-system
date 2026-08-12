# Phase 6 — Hardening + Deployment Prep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last gaps before a human can deploy this: security headers on every API response, a rate limit on seat holds that one user cannot use to sweep a showtime, an honest boot warning about the proxy setting, a load script that proves seats do not double-book, and a deployment document someone can follow without asking.

**Architecture:** The rate limiter grows from one hardcoded login counter into a small bucket abstraction with one bucket per use case — login keyed by IP (unchanged), seat holds keyed by `userId`. Keying holds on the authenticated user sidesteps the proxy problem entirely, because a user id comes from a JWT we signed rather than a header a client can forge. Everything else is additive: a headers middleware, a `console.warn`, a script, and a document.

**Spec:** `docs/superpowers/specs/2026-08-12-phase6-hardening-design.md` — read it before starting.

**Tech Stack:** Express 5 + TypeScript (ESM/NodeNext), Prisma v6, PostgreSQL, Redis, Vitest, `tsx`. **This phase adds no dependencies at all.**

## Global Constraints

- **No new npm dependencies, in either workspace.** Not helmet, not k6, not autocannon, not a rate-limit package. If you believe one is needed, stop and ask the user.
- **This phase does not deploy anything.** `CLAUDE.md` §5 and the project plan both reserve the first production deploy for a human.
- **This phase does not touch `apps/web`.** The headers here are the API's; Next.js serves its own.
- All business constants live in `apps/api/src/lib/config.ts`, each with a comment explaining the number.
- `apps/api/src` is ESM/NodeNext — **every relative import needs a `.js` extension**. Files under `tests/` must NOT have them.
- Routes stay thin adapters; shared logic lives in `apps/api/src/lib`.
- Money is `Int`. Not-authorised is `404`, never `403`. Neither is touched here, but do not regress them.
- **Never `deleteMany` without a `where` scoped to rows you created.** The dev Postgres is shared with other git worktrees. Never stop or restart the shared Postgres/Redis containers.
- Deliberate corner-cuts carry a `// LIMITATION:` or `// ponytail:` comment naming the ceiling and the upgrade trigger.
- Every branch needs a test that genuinely fails if the logic breaks.
- **Current baseline: `npm run build` clean, `npm test` = 168 unit tests across 21 files, `cd apps/api && npm run test:integration` = 10 tests.** All must keep passing.

## Lessons from Phases 4 and 5 that apply directly here

Each of these caused a real defect in this codebase within the last two weeks:

1. **Never write a comment that overstates what a test covers.** Phase 4 shipped a comment claiming a test reproduced a race it did not; the final review caught it by reverting the fix and watching the suite stay green. If you are unsure a test covers something, revert the code it guards and look.
2. **`vi.clearAllMocks()` does not reset a `mockResolvedValue`/`mockRejectedValue` implementation.** A value configured in one test leaks into later ones. Reset implementations in `beforeEach` if any test configures one.
3. **A boot guard's placeholder check must compare against the same constant `.env.example` actually ships.** Phase 4 shipped a guard that compared against a different string than the file contained, so a verbatim copy passed every check. There is now a drift test that reads `.env.example` from disk — read `tests/unit/api/config-guard.test.ts` before adding anything to that file.
4. **Reserve rate-limit budget synchronously, before any `await`.** `apps/api/src/routes/auth.ts` does this deliberately; its comment explains why. Incrementing after the await lets a concurrent burst all read the same pre-increment count and sail through.

---

### Task 1: Security headers

**Files:**
- Create: `apps/api/src/middleware/security-headers.ts`
- Modify: `apps/api/src/index.ts`
- Test: `tests/unit/api/security-headers.test.ts`

**Interfaces:**
- Produces: `securityHeaders: RequestHandler` — sets four headers and calls `next()`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api/security-headers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ORIGINAL_ENV = process.env.NODE_ENV

beforeEach(() => {
  vi.resetModules()
})
afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV
})

function makeRes() {
  const headers: Record<string, string> = {}
  return {
    headers,
    setHeader: (name: string, value: string) => {
      headers[name] = value
    },
  }
}

describe('securityHeaders', () => {
  it('sets the three always-on headers and calls next', async () => {
    process.env.NODE_ENV = 'development'
    const { securityHeaders } = await import(
      '../../../apps/api/src/middleware/security-headers'
    )
    const res = makeRes()
    const next = vi.fn()

    securityHeaders({} as never, res as never, next)

    expect(res.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(res.headers['X-Frame-Options']).toBe('DENY')
    expect(res.headers['Referrer-Policy']).toBe('no-referrer')
    expect(next).toHaveBeenCalledTimes(1)
  })

  // Setting HSTS while developing teaches the browser that localhost must be
  // HTTPS — for every port, for a year, across every other project on the
  // machine. It is painful to undo, so this must never fire outside
  // production.
  it('does not set HSTS outside production', async () => {
    process.env.NODE_ENV = 'development'
    const { securityHeaders } = await import(
      '../../../apps/api/src/middleware/security-headers'
    )
    const res = makeRes()

    securityHeaders({} as never, res as never, vi.fn())

    expect(res.headers['Strict-Transport-Security']).toBeUndefined()
  })

  it('sets HSTS in production', async () => {
    process.env.NODE_ENV = 'production'
    const { securityHeaders } = await import(
      '../../../apps/api/src/middleware/security-headers'
    )
    const res = makeRes()

    securityHeaders({} as never, res as never, vi.fn())

    expect(res.headers['Strict-Transport-Security']).toBe(
      'max-age=31536000; includeSubDomains',
    )
  })

  it('calls next exactly once even in production', async () => {
    process.env.NODE_ENV = 'production'
    const { securityHeaders } = await import(
      '../../../apps/api/src/middleware/security-headers'
    )
    const next = vi.fn()

    securityHeaders({} as never, makeRes() as never, next)

    expect(next).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/security-headers.test.ts`
Expected: FAIL — cannot resolve `middleware/security-headers`.

- [ ] **Step 3: Create `apps/api/src/middleware/security-headers.ts`**

```ts
import type { RequestHandler } from 'express'

// Read at call time, not at module load: the tests re-import this module
// with a different NODE_ENV, and a value captured at import would be stale.
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

// Set on every response, mounted ahead of every route.
//
// LIMITATION: no Content-Security-Policy. This service returns JSON and
// never HTML, so a CSP would constrain nothing. The day it serves any HTML
// — an error page, a docs route — CSP has to be added here, and the absence
// of one becomes a real hole rather than a no-op.
export const securityHeaders: RequestHandler = (_req, res, next) => {
  // Stop a browser from second-guessing our Content-Type and executing a
  // JSON body as script.
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // Nothing here should ever be framed.
  res.setHeader('X-Frame-Options', 'DENY')
  // Our URLs carry booking and ticket ids. Do not hand them to whatever
  // site a user clicks through to.
  res.setHeader('Referrer-Policy', 'no-referrer')

  // Production only, deliberately. Sent from a dev server, HSTS pins
  // localhost to HTTPS in the developer's browser for a year — across every
  // port and every other project on that machine — and clearing it is
  // awkward. The header is meaningless over plain HTTP anyway.
  if (isProduction()) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }

  next()
}
```

- [ ] **Step 4: Run the tests, expect pass**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/security-headers.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Mount it in `apps/api/src/index.ts`**

Add the import with the other middleware imports:

```ts
import { securityHeaders } from './middleware/security-headers.js'
```

Mount it **before `cors(...)` and before every route**, immediately after the `TRUST_PROXY` block, so that even a CORS rejection or a 404 carries the headers:

```ts
app.use(securityHeaders)
```

- [ ] **Step 6: Prove it reaches a real response**

Start the API (`npm run dev:api` from the repo root, in the background; check `docker info` first and never stop the shared containers), then:

```bash
curl -si http://localhost:4000/health | head -20
```

Confirm `X-Content-Type-Options`, `X-Frame-Options`, and `Referrer-Policy` are present and `Strict-Transport-Security` is **absent** (dev). Paste the real output into your report. Shut the server down afterwards.

- [ ] **Step 7: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS — 172 unit tests, no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/middleware/security-headers.ts apps/api/src/index.ts tests/unit/api/security-headers.test.ts
git commit -m "feat(api): add security headers, HSTS in production only"
```

---

### Task 2: Per-use-case rate limit buckets, and the seat-hold limit

**Files:**
- Modify: `apps/api/src/lib/rate-limit.ts`
- Modify: `apps/api/src/lib/config.ts`
- Modify: `apps/api/src/routes/showtimes.ts`
- Test: `tests/unit/api/rate-limit.test.ts` (extend — do not alter existing assertions)
- Test: `tests/unit/api/booking-rate-limit.test.ts`

**Interfaces:**
- Consumes: `LOGIN_RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_WINDOW_MS` (already in config).
- Produces in `config.ts`: `BOOKING_RATE_LIMIT_MAX = 10`, `BOOKING_RATE_LIMIT_WINDOW_MS = 60_000`.
- Produces in `lib/rate-limit.ts`, **keeping every existing export's name and signature unchanged**: `isRateLimited(key: string): boolean`, `recordLoginFailure(key: string): void`, `refundAttempt(key: string): void`, `resetRateLimitState(): void`; and new `isBookingRateLimited(userId: string): boolean`, `recordBookingAttempt(userId: string): void`.

**Read `apps/api/src/lib/rate-limit.ts` and `apps/api/src/routes/auth.ts` in full before touching anything.** The login path reserves budget synchronously before its `await` on purpose, and its comments explain why. That behaviour must survive this refactor exactly.

- [ ] **Step 1: Add the constants to `apps/api/src/lib/config.ts`**

```ts
// Seat-hold guard. MAX_SEATS_PER_BOOKING caps one booking, not how many
// bookings a user may open — without this, one account can hold a whole
// showtime a few seats at a time. Keyed on the authenticated user id rather
// than the IP: /showtimes/:id/seats/hold requires a session anyway, and a
// user id comes from a JWT we signed instead of a header a client can set,
// so this bucket is unaffected by whether TRUST_PROXY is on.
//
// 10 per minute leaves room for someone changing their mind repeatedly while
// picking seats, and still bounds how fast one account can accumulate holds.
export const BOOKING_RATE_LIMIT_MAX = 10
export const BOOKING_RATE_LIMIT_WINDOW_MS = 60 * 1000
```

- [ ] **Step 2: Write the failing tests for the new bucket**

Create `tests/unit/api/booking-rate-limit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  isBookingRateLimited,
  recordBookingAttempt,
  isRateLimited,
  recordLoginFailure,
  resetRateLimitState,
} from '../../../apps/api/src/lib/rate-limit'
import {
  BOOKING_RATE_LIMIT_MAX,
  LOGIN_RATE_LIMIT_MAX,
} from '../../../apps/api/src/lib/config'

beforeEach(() => {
  resetRateLimitState()
})

describe('booking rate limit', () => {
  it('allows a user under the limit', () => {
    for (let i = 0; i < BOOKING_RATE_LIMIT_MAX - 1; i++) {
      recordBookingAttempt('user-1')
    }
    expect(isBookingRateLimited('user-1')).toBe(false)
  })

  it('blocks a user once they reach the limit', () => {
    for (let i = 0; i < BOOKING_RATE_LIMIT_MAX; i++) {
      recordBookingAttempt('user-1')
    }
    expect(isBookingRateLimited('user-1')).toBe(true)
  })

  // The whole reason for keying on the user id. If the buckets were shared
  // or the key were the proxy's IP, one user hitting the limit would lock
  // out everyone else booking at the same time.
  it('does not charge one user against another', () => {
    for (let i = 0; i < BOOKING_RATE_LIMIT_MAX; i++) {
      recordBookingAttempt('user-1')
    }
    expect(isBookingRateLimited('user-2')).toBe(false)
  })

  // Separate buckets: exhausting the booking budget must not lock a user
  // out of logging in, and vice versa.
  it('keeps the login and booking budgets independent', () => {
    for (let i = 0; i < BOOKING_RATE_LIMIT_MAX; i++) {
      recordBookingAttempt('same-key')
    }
    expect(isBookingRateLimited('same-key')).toBe(true)
    expect(isRateLimited('same-key')).toBe(false)

    resetRateLimitState()

    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) {
      recordLoginFailure('same-key')
    }
    expect(isRateLimited('same-key')).toBe(true)
    expect(isBookingRateLimited('same-key')).toBe(false)
  })

  it('clears both buckets on reset', () => {
    for (let i = 0; i < BOOKING_RATE_LIMIT_MAX; i++) recordBookingAttempt('user-1')
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) recordLoginFailure('1.2.3.4')

    resetRateLimitState()

    expect(isBookingRateLimited('user-1')).toBe(false)
    expect(isRateLimited('1.2.3.4')).toBe(false)
  })

  // A limit that never lifts is a ban. Read how the existing
  // tests/unit/api/rate-limit.test.ts advances time for the login bucket and
  // use the same mechanism here rather than sleeping for a real minute.
  it('lets the user through again once the window has elapsed', () => {
    vi.useFakeTimers()
    try {
      for (let i = 0; i < BOOKING_RATE_LIMIT_MAX; i++) recordBookingAttempt('user-1')
      expect(isBookingRateLimited('user-1')).toBe(true)

      vi.advanceTimersByTime(BOOKING_RATE_LIMIT_WINDOW_MS)

      expect(isBookingRateLimited('user-1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
```

Add `vi` to this file's `vitest` import and `BOOKING_RATE_LIMIT_WINDOW_MS` to the config import.

- [ ] **Step 3: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/booking-rate-limit.test.ts`
Expected: FAIL — `isBookingRateLimited is not a function`.

- [ ] **Step 4: Refactor `apps/api/src/lib/rate-limit.ts` into buckets**

Keep every existing comment that explains *why* (the synchronous-reservation note, the `TRUST_PROXY` limitation, the sweep's `ponytail:` note) — move them to the right place rather than deleting them. Replace the module body with:

```ts
import {
  LOGIN_RATE_LIMIT_MAX,
  LOGIN_RATE_LIMIT_WINDOW_MS,
  BOOKING_RATE_LIMIT_MAX,
  BOOKING_RATE_LIMIT_WINDOW_MS,
} from './config.js'

type Entry = { count: number; windowStart: number }
type Bucket = { entries: Map<string, Entry>; max: number; windowMs: number }

function createBucket(max: number, windowMs: number): Bucket {
  return { entries: new Map(), max, windowMs }
}

function isExpired(bucket: Bucket, entry: Entry, now: number): boolean {
  return now - entry.windowStart >= bucket.windowMs
}

// Sweeps entries whose window has already elapsed.
//
// ponytail: this bounds *retention* (a key cannot outlive one window past
// its last write), not *size* — within a single window every distinct key
// gets an entry, so an attacker rotating through many IPv6 addresses can
// still grow the Map arbitrarily during that window. The scan is also
// O(bucket size) on every call, so heavy distinct-key traffic is quadratic.
// Fine at this scale for a single instance; move to Redis (with TTL-based
// expiry) if either becomes real.
function sweep(bucket: Bucket, now: number): void {
  for (const [key, entry] of bucket.entries) {
    if (isExpired(bucket, entry, now)) bucket.entries.delete(key)
  }
}

// True when `key` has used up its budget for the current window. Checks
// expiry itself rather than relying on sweep() having run, so a stale entry
// can never read as still-limited.
function isLimited(bucket: Bucket, key: string): boolean {
  const now = Date.now()
  sweep(bucket, now)
  const entry = bucket.entries.get(key)
  if (!entry || isExpired(bucket, entry, now)) return false
  return entry.count >= bucket.max
}

function record(bucket: Bucket, key: string): void {
  const now = Date.now()
  const entry = bucket.entries.get(key)
  if (!entry || isExpired(bucket, entry, now)) {
    bucket.entries.set(key, { count: 1, windowStart: now })
    return
  }
  entry.count += 1
}

function refund(bucket: Bucket, key: string): void {
  const entry = bucket.entries.get(key)
  if (entry && entry.count > 0) entry.count -= 1
}

// One bucket per use case. Sharing a Map would mean a user who exhausted
// their seat-hold budget could not log in either.
const loginBucket = createBucket(LOGIN_RATE_LIMIT_MAX, LOGIN_RATE_LIMIT_WINDOW_MS)
const bookingBucket = createBucket(BOOKING_RATE_LIMIT_MAX, BOOKING_RATE_LIMIT_WINDOW_MS)

// --- Login: keyed by IP, counts only failures ---
//
// LIMITATION: keyed on req.ip. Express derives that from X-Forwarded-For
// only when `trust proxy` is enabled (config.ts's TRUST_PROXY, default off).
// Left off behind a reverse proxy, every request arrives as the proxy's
// single IP — so one attacker's wrong passwords share a bucket with every
// other user and lock them all out of login for the window. Turning
// TRUST_PROXY on fixes that, but only do it when a trusted proxy really is
// in front; otherwise a client can spoof the header and dodge the limiter.
// index.ts warns at boot when this looks wrong. The seat-hold bucket below
// avoids the problem entirely by keying on the authenticated user id.

export function isRateLimited(key: string): boolean {
  return isLimited(loginBucket, key)
}

// Reserves budget *before* the login attempt runs — see the call site in
// routes/auth.ts, which calls this synchronously with isRateLimited(),
// before its `await`. Incrementing only after the await let every request
// in a concurrent burst read the same pre-increment count and slip through
// the gate for free.
export function recordLoginFailure(key: string): void {
  record(loginBucket, key)
}

// Refunds a reservation after a login that turned out to succeed, so only
// genuine failures stay counted.
export function refundAttempt(key: string): void {
  refund(loginBucket, key)
}

// --- Seat holds: keyed by user id, counts every attempt ---
//
// No refund counterpart, deliberately: a successful hold is exactly what
// this limit exists to bound, so it must stay charged.

export function isBookingRateLimited(userId: string): boolean {
  return isLimited(bookingBucket, userId)
}

export function recordBookingAttempt(userId: string): void {
  record(bookingBucket, userId)
}

// Test-only: clears every bucket so tests do not leak into each other.
export function resetRateLimitState(): void {
  loginBucket.entries.clear()
  bookingBucket.entries.clear()
}
```

- [ ] **Step 5: Run the whole rate-limit surface**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/booking-rate-limit.test.ts ../../tests/unit/api/rate-limit.test.ts ../../tests/unit/api/auth-routes.test.ts`
Expected: PASS. **The existing `rate-limit.test.ts` and `auth-routes.test.ts` must pass with no edits to their assertions** — that is the proof the login behaviour is unchanged. If you find yourself wanting to edit one, stop: the refactor broke something.

- [ ] **Step 6: Write the failing test for the hold route's guard**

Append to `tests/unit/api/booking-rate-limit.test.ts`. Read `tests/unit/api/seats.test.ts` or `auth-routes.test.ts` first for the house pattern of faking `req`/`res`, and reuse it.

**Merge these imports into the ones already at the top of the file — do not add a second import block.** `vi.hoisted` and `vi.mock` must sit above the `holdSeatsHandler` import, since the mock has to be registered before the module under test is loaded:

```ts
const m = vi.hoisted(() => ({ createBooking: vi.fn() }))

vi.mock('../../../apps/api/src/lib/booking', () => ({
  createBooking: m.createBooking,
  TooManySeatsError: class TooManySeatsError extends Error {},
  SeatUnavailableError: class SeatUnavailableError extends Error {},
}))

import { holdSeatsHandler } from '../../../apps/api/src/routes/showtimes'

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() } as any
  res.status.mockReturnValue(res)
  res.json.mockReturnValue(res)
  return res
}

function holdReq(userId: string) {
  return { params: { id: 'st1' }, body: { seatIds: ['s1'] }, user: { id: userId } } as never
}

describe('POST /showtimes/:id/seats/hold rate limit', () => {
  it('429s once the user is over the limit, without touching the booking layer', async () => {
    resetRateLimitState()
    for (let i = 0; i < BOOKING_RATE_LIMIT_MAX; i++) recordBookingAttempt('user-1')
    const res = makeRes()

    await holdSeatsHandler(holdReq('user-1'), res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(429)
    expect(m.createBooking).not.toHaveBeenCalled()
  })

  it('lets a different user through', async () => {
    resetRateLimitState()
    for (let i = 0; i < BOOKING_RATE_LIMIT_MAX; i++) recordBookingAttempt('user-1')
    m.createBooking.mockResolvedValue({
      id: 'b1',
      status: 'PENDING_PAYMENT',
      totalPrice: 1000,
      expiresAt: new Date(),
    })
    const res = makeRes()

    await holdSeatsHandler(holdReq('user-2'), res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(201)
    expect(m.createBooking).toHaveBeenCalledTimes(1)
  })

  // Charged whether or not the booking succeeds — a burst of failures is
  // exactly the pattern this limit exists to slow down.
  it('charges the attempt even when the booking fails', async () => {
    resetRateLimitState()
    m.createBooking.mockRejectedValue(new Error('boom'))
    const res = makeRes()

    await holdSeatsHandler(holdReq('user-3'), res, vi.fn())

    for (let i = 0; i < BOOKING_RATE_LIMIT_MAX - 1; i++) recordBookingAttempt('user-3')
    expect(isBookingRateLimited('user-3')).toBe(true)
  })
})
```

**Note on mock hygiene** (lesson 2 in the header): if you add any `mockRejectedValue`, reset the implementation in `beforeEach` — `vi.clearAllMocks()` alone will leak it into the next test.

- [ ] **Step 7: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/booking-rate-limit.test.ts`
Expected: FAIL — the handler currently returns 201/500, never 429.

- [ ] **Step 8: Wire the guard into `apps/api/src/routes/showtimes.ts`**

Add to the imports:

```ts
import { isBookingRateLimited, recordBookingAttempt } from '../lib/rate-limit.js'
```

In `holdSeatsHandler`, after the `userId` check and **before** the `try` block:

```ts
  if (isBookingRateLimited(userId)) {
    return res.status(429).json({ error: 'Too many booking attempts. Please try again shortly.' })
  }
  // Reserved synchronously, before the await below — the same reason
  // routes/auth.ts reserves before its await. Charging only after
  // createBooking resolves would let a concurrent burst all read the same
  // pre-increment count and pass the gate together, which is precisely the
  // sweep-the-showtime case this guards.
  recordBookingAttempt(userId)
```

There is no refund on success: every attempt stays charged.

- [ ] **Step 9: Run the tests, expect pass**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/booking-rate-limit.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 10: Prove the reservation really is synchronous**

Move `recordBookingAttempt(userId)` to just after the `await createBooking(...)` line and re-run. Then reason about (and state in your report) whether any current test catches the difference. **If none does, say so plainly rather than implying the ordering is covered** — the ordering matters under real concurrency, which unit tests with a mocked booking layer cannot reproduce. Restore the original position before committing.

- [ ] **Step 11: Add the production `TRUST_PROXY` warning**

In `apps/api/src/index.ts`, replace the existing `TRUST_PROXY` block with:

```ts
// Opt-in — see the TRUST_PROXY comment in lib/config.ts. Only enable this
// when a trusted reverse proxy actually sits in front of this process.
if (TRUST_PROXY) {
  app.set('trust proxy', true)
} else if (process.env.NODE_ENV === 'production') {
  // A warning, not a throw: a deploy straight onto a VPS with no proxy is a
  // correct configuration, and refusing to boot would block it. But the
  // opposite mistake is silent and expensive — behind a proxy with this off,
  // every request arrives as the proxy's IP, so five wrong passwords from one
  // attacker lock every user out of login for the window.
  console.warn(
    'TRUST_PROXY is off in production. If this process sits behind a reverse proxy (most PaaS do), every request arrives as the proxy IP and the login rate limiter will lock all users out together. If nothing proxies this process, leaving it off is correct — see docs/DEPLOYMENT.md.',
  )
}
```

- [ ] **Step 12: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS — 181 unit tests, no type errors.

- [ ] **Step 13: Commit**

```bash
git add apps/api/src/lib/rate-limit.ts apps/api/src/lib/config.ts apps/api/src/routes/showtimes.ts apps/api/src/index.ts tests/unit/api/booking-rate-limit.test.ts
git commit -m "feat(api): rate-limit seat holds per user and warn on production proxy config"
```

---

### Task 3: The seat-contention load script

**Files:**
- Create: `tests/load/booking-burst.ts`
- Modify: `package.json` (root — one script entry)

**Interfaces:**
- Consumes: the running API over HTTP, and `prisma` from `apps/api/src/lib/prisma` for setup, verification and teardown.
- Produces: nothing other code imports. It is run by a human.

**Read `tests/integration/helpers.ts` first.** Build the fixture the same way and tear down the same way — scoped to ids this script created, never an unscoped `deleteMany`.

- [ ] **Step 1: Create `tests/load/booking-burst.ts`**

```ts
// Answers one question: when N people grab the same seat at the same instant,
// does exactly one of them get it?
//
// Run by hand against a running API — not part of any suite, because it needs
// a live server:
//   npm run dev:api          # in one terminal
//   npm run load:booking     # in another
//
// LIMITATION: measures correctness, not throughput. It reports no latency
// percentiles and no requests/second. Answering "how many bookings per second
// can this take" needs a real load tool, which means a new dependency — ask
// before adding one.
import { prisma } from '../../apps/api/src/lib/prisma'

const API = process.env.API_BASE_URL ?? 'http://localhost:4000'
const CONTENDERS = Number(process.env.CONTENDERS ?? 50)
const PASSWORD = 'load-test-password-1234'

async function main() {
  console.log(`Load: ${CONTENDERS} users contending for one seat against ${API}`)

  const stamp = Date.now()
  const venue = await prisma.venue.create({
    data: { name: `load ${stamp} venue`, address: 'n/a' },
  })
  const event = await prisma.event.create({
    data: { title: `load ${stamp} event`, description: 'n/a', venueId: venue.id },
  })
  const showtime = await prisma.showtime.create({
    data: {
      eventId: event.id,
      startTime: new Date(Date.now() + 60 * 60 * 1000),
      endTime: new Date(Date.now() + 2 * 60 * 60 * 1000),
    },
  })
  const seatMap = await prisma.seatMap.create({
    data: { showtimeId: showtime.id, zoneName: 'LOAD', price: 1000 },
  })
  const seat = await prisma.seat.create({
    data: { seatMapId: seatMap.id, row: 'A', number: 1 },
  })

  // Register through the real API so the passwords hash the same way login
  // expects, then keep each user's session cookie.
  const emails: string[] = []
  const cookies: string[] = []
  for (let i = 0; i < CONTENDERS; i++) {
    const email = `load-${stamp}-${i}@example.com`
    emails.push(email)
    const res = await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, name: `Load ${i}` }),
    })
    if (!res.ok) throw new Error(`register failed for ${email}: ${res.status}`)

    const login = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
    const cookie = login.headers.get('set-cookie')
    if (!login.ok || !cookie) throw new Error(`login failed for ${email}: ${login.status}`)
    cookies.push(cookie.split(';')[0])
  }

  // The burst. Fired together, not in a loop — a sequential loop proves
  // nothing about contention.
  const results = await Promise.allSettled(
    cookies.map((cookie) =>
      fetch(`${API}/showtimes/${showtime.id}/seats/hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ seatIds: [seat.id] }),
      }).then(async (r) => ({ status: r.status, body: await r.text() })),
    ),
  )

  const statuses = new Map<number | string, number>()
  for (const r of results) {
    const key = r.status === 'fulfilled' ? r.value.status : 'network-error'
    statuses.set(key, (statuses.get(key) ?? 0) + 1)
  }

  // The number that actually matters. HTTP responses can lie — two 201s with
  // one row, or one 201 with two rows, are both possible failure modes. Count
  // the rows.
  const rows = await prisma.bookingSeat.count({ where: { seatId: seat.id } })

  console.log('\nHTTP results:')
  for (const [status, count] of [...statuses].sort()) {
    console.log(`  ${status}: ${count}`)
  }
  console.log(`\nBookingSeat rows for the contended seat: ${rows}`)
  console.log(rows === 1 ? 'PASS — exactly one booking holds the seat' : `FAIL — expected 1, got ${rows}`)

  // Teardown, scoped to ids this run created. The dev Postgres is shared
  // with other worktrees; never widen these filters.
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  })
  const userIds = users.map((u) => u.id)
  await prisma.bookingSeat.deleteMany({ where: { seatId: seat.id } })
  await prisma.ticket.deleteMany({ where: { booking: { userId: { in: userIds } } } })
  await prisma.payment.deleteMany({ where: { booking: { userId: { in: userIds } } } })
  await prisma.booking.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.seat.deleteMany({ where: { id: seat.id } })
  await prisma.seatMap.deleteMany({ where: { id: seatMap.id } })
  await prisma.showtime.deleteMany({ where: { id: showtime.id } })
  await prisma.event.deleteMany({ where: { id: event.id } })
  await prisma.venue.deleteMany({ where: { id: venue.id } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })

  if (rows !== 1) process.exitCode = 1
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Add the script entry to the root `package.json`**

```json
    "load:booking": "tsx --env-file-if-exists=apps/api/.env tests/load/booking-burst.ts"
```

`tsx` is already a devDependency of `apps/api` and resolves from the workspace root. **Do not install anything.**

- [ ] **Step 3: Run it for real**

Check `docker info` first; never stop or restart the shared containers. Start the API (`npm run dev:api` in the background), then:

```bash
npm run load:booking
```

Expected: exactly one `201`, the rest `409`, and `BookingSeat rows for the contended seat: 1`.

**Note:** the seat-hold rate limit from Task 2 is keyed per user and each contender is a distinct user, so it must not interfere. If you see `429`s, that is a finding worth reporting, not something to work around by raising the limit.

Paste the real output into your report. Shut the API down afterwards.

- [ ] **Step 4: Prove the script can actually fail**

Temporarily change the count assertion's expected value from `1` to `2` and re-run — it must print `FAIL` and exit non-zero. Restore it. A load script that cannot report failure is decoration. Record both runs in your report.

- [ ] **Step 5: Confirm teardown left nothing behind**

```bash
cd apps/api && npx tsx -e "import {prisma} from './src/lib/prisma.ts'; console.log(await prisma.venue.count({where:{name:{startsWith:'load '}}}), await prisma.user.count({where:{email:{startsWith:'load-'}}})); await prisma.\$disconnect()"
```

Expected: `0 0`. If not, report exactly what was left and do **not** widen any delete filter to clean it — surface it instead.

- [ ] **Step 6: Commit**

```bash
git add tests/load/booking-burst.ts package.json
git commit -m "test(load): add a seat-contention burst script"
```

---

### Task 4: Deployment documentation

**Files:**
- Create: `docs/DEPLOYMENT.md`
- Modify: `README.md` (one link)

**Interfaces:** none — this task produces prose.

Write for someone who has this repo, has never seen it before, and has to put it online. **Provider-neutral**: the user has not chosen a host, so name no vendor as required.

Before writing, verify every claim you are about to make against the code — do not copy them from this plan on faith:

```bash
grep -rn "throw new Error" apps/api/src/lib/config.ts
grep -ril "drop " apps/api/prisma/migrations/ || echo "no DROP in any migration"
grep -n "NODE_ENV" apps/api/src/lib/config.ts apps/api/src/index.ts
```

- [ ] **Step 1: Write `docs/DEPLOYMENT.md`**

It must cover, each as its own section:

**1. Required environment variables.** One table: variable, what it does, and what happens if it is missing or wrong. Derive the list from `apps/api/src/lib/config.ts` rather than from memory. Mark which ones a boot guard refuses to start without — currently `JWT_SECRET`, `PAYMENT_WEBHOOK_SECRET` and `TICKET_SIGNING_SECRET` (each also rejected when left as the committed `.env.example` placeholder), plus `PAYMENT_PROVIDER=mock`, which is refused outright in production because the mock provider marks bookings paid with no money involved.

**2. Variables that need a decision.** `TRUST_PROXY` — on behind a reverse proxy (most managed platforms), off on a bare VM; explain both failure modes: left off behind a proxy, one attacker's failed logins lock out every user; turned on with nothing proxying, a client sets `X-Forwarded-For` itself and skips the limiter entirely. `RESEND_API_KEY` — unset means confirmation emails are only logged, never sent. `FRONTEND_ORIGIN` — the single origin CORS allows, and the base of the ticket links inside emails.

**3. Deploy order.** Run `prisma migrate deploy` to completion before shifting traffic. Every migration in this repo is additive, so the old code keeps working against the new schema — that is what makes this order safe, and it stops being true the day someone writes a destructive migration.

**4. Rollback.** State the verified fact and how you verified it: no migration in `apps/api/prisma/migrations/` contains a `DROP`, so rolling back means redeploying the previous code with the schema left alone. If a migration genuinely must be undone, mark it with `prisma migrate resolve --rolled-back <name>` and write a new forward migration that reverses it — **never edit a migration that has already been applied.**

**5. First deploy is a human's.** `CLAUDE.md` §5 and the project plan both require it. Say so.

**6. What has never been verified.** Write these plainly; they are the point of this section, not a footnote:
- Confirmation email has never actually been sent. No `RESEND_API_KEY` has ever been configured, so `lib/email.ts`'s send path has never executed — only the request shape and the no-key logging path are proven. A wrong `EMAIL_FROM` domain or an unverified Resend sender would first appear in staging.
- Nobody has opened the six pages built in Phases 4 and 5 in a browser. All checks were made at the HTTP layer.
- No QR code has been scanned with a real camera.

**7. Running the load check.** How to run `npm run load:booking`, what a pass looks like, and that it needs a live API.

- [ ] **Step 2: Link it from `README.md`**

Add one line under the existing deployment notes pointing at `docs/DEPLOYMENT.md`. Do not restructure the README.

- [ ] **Step 3: Verify the document against reality**

Re-run the three `grep` commands above and check each claim in your document matches their output. Fix any that do not. **State in your report which claims you verified and how** — a deployment document that is confidently wrong is worse than none, because someone will follow it at 2am.

- [ ] **Step 4: Commit**

```bash
git add docs/DEPLOYMENT.md README.md
git commit -m "docs: add deployment and rollback guide"
```

---

## Definition of Done

Per `CLAUDE.md` §6:

1. `npm run build` clean in both workspaces.
2. `npm test` green — 181 unit tests — and `cd apps/api && npm run test:integration` green, 10 tests.
3. `npm run load:booking` run at least once against a live API, with its real output recorded.
4. A summary of what was built, what was deliberately skipped, and what a human must review.

**One Phase 6 checklist item is deliberately left open, and the summary must say so rather than implying otherwise:**

- **"คนตรวจสอบ (ไม่ใช่ agent) เป็นคน trigger deploy จริงครั้งแรก"** — nothing is deployed by this phase. That is the intended outcome, not a shortfall.

## Deliberately out of scope

| Skipped | Add when |
|---|---|
| The actual deploy | A human does it — `CLAUDE.md` §5 |
| Content-Security-Policy | The API starts serving HTML |
| Throughput / p95 measurement | Someone needs a capacity number — needs a new dependency, so **ask first** |
| Graceful shutdown | A real request gets cut off mid-flight |
| Health check that probes DB and Redis | Something consumes the result |
| Sentry / APM | Someone has to debug a production error — new dependency, **ask first** |
| CI/CD pipeline | More than one person deploys |
| Redis-backed rate limiting | More than one API instance runs, or restarts start losing meaningful state |
| Rate limit on `/bookings/:id/checkout` | That endpoint returns the existing session on a repeat call, so hammering it consumes nothing |
