# Phase 3 — Payment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry a `PENDING_PAYMENT` booking through to `PAID` using a self-hosted mock payment provider that keeps the real architecture — checkout session, signed webhook, HMAC verification from the raw body, and idempotency enforced by a unique constraint.

**Spec:** `docs/superpowers/specs/2026-08-11-phase3-payment-design.md` — read it before starting.

**Tech Stack:** Express 5 + TypeScript (ESM/NodeNext), Prisma v6, PostgreSQL, Redis, Next.js 16, Tailwind v4, Vitest, `node:crypto` (no new dependencies).

## Global Constraints

- npm workspaces: `apps/api` owns all business logic and DB access; `apps/web` is UI only.
- `apps/api/src` is ESM/NodeNext — **every relative import needs a `.js` extension**. Files under `tests/` must NOT have them. `apps/web` uses bundler resolution — no extensions.
- All business constants live in `apps/api/src/lib/config.ts`.
- **Money is `Int` (whole baht). `amount` is always read from `booking.totalPrice` in the database — never from a request body.**
- Business logic lives in `apps/api/src/lib` as shared functions; routes are thin adapters matching the style of `apps/api/src/routes/events.ts` (zod `safeParse` → `400` with `parsed.error.flatten()`; named exported handlers; `try/catch` → `logServerError(...)` → generic `500 { error: 'Internal server error' }`).
- Not-owner returns **404**, never 403.
- **`CLAUDE.md` §5: webhook signature verification must never be disabled, skipped, or made conditional — not even temporarily for debugging.**
- State changes happen in ONE transaction. Never split them.
- **No new dependencies.** HMAC uses `node:crypto`.
- Migrations are additive. No `DROP` without approval.
- No secrets committed; `.env` is gitignored, `.env.example` carries placeholders.
- Deliberate corner-cuts carry a `// ponytail:` or `// LIMITATION:` comment naming the ceiling.
- Branching logic needs at least one test that genuinely fails if the logic breaks.
- Current baseline: root `npm run build` clean, `npm test` 56 unit tests, `cd apps/api && npm run test:integration` 2 tests. All must keep passing.

---

### Task 1: Schema, constants, and the production guard

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/lib/config.ts`
- Modify: `apps/api/.env.example`
- Test: `tests/unit/api/config-guard.test.ts`

**Interfaces:**
- Produces models `Payment`, `WebhookEvent`; enum `PaymentStatus`; `BookingStatus.REFUND_REQUIRED`.
- Produces `config.ts` exports `PAYMENT_PROVIDER: string`, `PAYMENT_WEBHOOK_SECRET: string`, `API_BASE_URL: string`, and `assertPaymentProviderIsSafe()`.

- [ ] **Step 1: Append to `apps/api/prisma/schema.prisma`**

```prisma
enum PaymentStatus {
  PENDING
  SUCCEEDED
  FAILED
}

model Payment {
  id          String        @id @default(cuid())
  bookingId   String        @unique
  booking     Booking       @relation(fields: [bookingId], references: [id])
  provider    String
  providerRef String        @unique
  amount      Int
  status      PaymentStatus @default(PENDING)
  paidAt      DateTime?
  createdAt   DateTime      @default(now())
}

// Idempotency ledger. A provider may deliver the same event more than once
// (retry after a timeout, at-least-once delivery). Inserting the id inside
// the same transaction as the effect means a duplicate loses to the unique
// constraint instead of applying the effect twice.
model WebhookEvent {
  id         String   @id @default(cuid())
  eventId    String   @unique
  receivedAt DateTime @default(now())
}
```

Add `REFUND_REQUIRED` to the existing `BookingStatus` enum, and the back-relation on `Booking`:

```prisma
model Booking {
  // ...existing fields unchanged...
  payment Payment?
}
```

- [ ] **Step 2: Append to `apps/api/src/lib/config.ts`**

```ts
// 'mock' runs a self-hosted fake provider so the payment flow can be
// demonstrated without a real payment account. Swapping to a real provider
// is meant to be a change at the provider layer only, not in booking logic.
export const PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER ?? 'mock'

// Shared secret the provider signs webhook bodies with. The dev fallback is
// committed and therefore not a secret; production must set a real one.
export const PAYMENT_WEBHOOK_SECRET =
  process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev-webhook-secret-change-me'

// Where the mock provider posts its webhook back to. Only used by the mock.
export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000'

// The mock provider can mark any booking PAID with no money involved. Shipped
// to production it is a free-tickets endpoint for anyone who finds it, so a
// production boot with the mock enabled must fail loudly rather than quietly
// expose it. index.ts additionally refuses to mount the route at all unless
// the provider is 'mock'.
export function assertPaymentProviderIsSafe(): void {
  if (process.env.NODE_ENV === 'production' && PAYMENT_PROVIDER === 'mock') {
    throw new Error(
      'Refusing to start: PAYMENT_PROVIDER=mock in production would let anyone mark a booking PAID without paying.',
    )
  }
  if (process.env.NODE_ENV === 'production' && !process.env.PAYMENT_WEBHOOK_SECRET) {
    throw new Error('PAYMENT_WEBHOOK_SECRET must be set when NODE_ENV=production')
  }
}
```

- [ ] **Step 3: Append to `apps/api/.env.example`**

```
PAYMENT_PROVIDER="mock"
PAYMENT_WEBHOOK_SECRET="dev-webhook-secret-change-me"
API_BASE_URL="http://localhost:4000"
```

Mirror these into your local `apps/api/.env` (gitignored — never commit it).

- [ ] **Step 4: Write the guard test — `tests/unit/api/config-guard.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest'

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  vi.resetModules()
})

import { vi } from 'vitest'

describe('assertPaymentProviderIsSafe', () => {
  it('throws when the mock provider is enabled in production', async () => {
    process.env.NODE_ENV = 'production'
    process.env.PAYMENT_PROVIDER = 'mock'
    process.env.JWT_SECRET = 'x'
    process.env.PAYMENT_WEBHOOK_SECRET = 'y'
    vi.resetModules()
    const { assertPaymentProviderIsSafe } = await import('../../../apps/api/src/lib/config')
    expect(() => assertPaymentProviderIsSafe()).toThrow(/mock/i)
  })

  it('throws in production when the webhook secret is unset', async () => {
    process.env.NODE_ENV = 'production'
    process.env.PAYMENT_PROVIDER = 'stripe'
    process.env.JWT_SECRET = 'x'
    delete process.env.PAYMENT_WEBHOOK_SECRET
    vi.resetModules()
    const { assertPaymentProviderIsSafe } = await import('../../../apps/api/src/lib/config')
    expect(() => assertPaymentProviderIsSafe()).toThrow(/PAYMENT_WEBHOOK_SECRET/)
  })

  it('does not throw in development with the mock provider', async () => {
    process.env.NODE_ENV = 'development'
    process.env.PAYMENT_PROVIDER = 'mock'
    vi.resetModules()
    const { assertPaymentProviderIsSafe } = await import('../../../apps/api/src/lib/config')
    expect(() => assertPaymentProviderIsSafe()).not.toThrow()
  })
})
```

Note `config.ts` already throws at import time when `NODE_ENV=production` without `JWT_SECRET`, which is why the first two cases set it.

- [ ] **Step 5: Create and apply the migration**

Run:
```bash
docker compose up -d postgres redis
cd apps/api && npx prisma migrate dev --name payments
```
Read the generated `migration.sql` and confirm it contains no `DROP`.

- [ ] **Step 6: Verify**

Run: `cd apps/api && npx tsc --noEmit && npx vitest run` then `npm test` from the root.
Expected: clean typecheck, all tests pass including the three new guard tests.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma apps/api/src/lib/config.ts apps/api/.env.example tests/unit/api/config-guard.test.ts
git commit -m "feat(api): add Payment/WebhookEvent schema and payment config guards"
```

---

### Task 2: Webhook signature helper

**Files:**
- Create: `apps/api/src/lib/webhook-signature.ts`
- Test: `tests/unit/api/webhook-signature.test.ts`

**Interfaces:**
- Produces `signWebhookPayload(rawBody: string | Buffer): string` and `verifyWebhookSignature(rawBody: string | Buffer, signature: string | undefined): boolean`. Consumed by Tasks 4 and 5.

This is a security primitive. Get it right before anything depends on it.

- [ ] **Step 1: Write the failing test — `tests/unit/api/webhook-signature.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import {
  signWebhookPayload,
  verifyWebhookSignature,
} from '../../../apps/api/src/lib/webhook-signature'

const body = JSON.stringify({ eventId: 'evt_1', outcome: 'succeeded', amount: 4700 })

describe('verifyWebhookSignature', () => {
  it('accepts a signature this module produced', () => {
    expect(verifyWebhookSignature(body, signWebhookPayload(body))).toBe(true)
  })

  it('rejects a wrong signature', () => {
    expect(verifyWebhookSignature(body, 'deadbeef')).toBe(false)
  })

  it('rejects a body altered by a single character after signing', () => {
    const signature = signWebhookPayload(body)
    const tampered = body.replace('4700', '4701')
    expect(verifyWebhookSignature(tampered, signature)).toBe(false)
  })

  it('rejects a missing signature', () => {
    expect(verifyWebhookSignature(body, undefined)).toBe(false)
  })

  it('rejects an empty signature', () => {
    expect(verifyWebhookSignature(body, '')).toBe(false)
  })

  // timingSafeEqual throws on a length mismatch; the helper must not leak that
  // as an exception the route would turn into a 500.
  it('rejects a signature of the wrong length without throwing', () => {
    expect(() => verifyWebhookSignature(body, 'ab')).not.toThrow()
    expect(verifyWebhookSignature(body, 'ab')).toBe(false)
  })

  it('rejects a non-hex signature without throwing', () => {
    expect(() => verifyWebhookSignature(body, 'zzzz')).not.toThrow()
    expect(verifyWebhookSignature(body, 'zzzz')).toBe(false)
  })

  it('signs a Buffer and a string identically', () => {
    expect(signWebhookPayload(Buffer.from(body))).toBe(signWebhookPayload(body))
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/api && npx vitest run`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `apps/api/src/lib/webhook-signature.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'
import { PAYMENT_WEBHOOK_SECRET } from './config.js'

// HMAC-SHA256 over the exact bytes that were transmitted. It must be the raw
// body, never a re-serialized object: re-stringifying can reorder keys or
// change whitespace, and the signature would then never match.
export function signWebhookPayload(rawBody: string | Buffer): string {
  return createHmac('sha256', PAYMENT_WEBHOOK_SECRET).update(rawBody).digest('hex')
}

export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string | undefined,
): boolean {
  if (!signature) return false

  const expected = Buffer.from(signWebhookPayload(rawBody), 'hex')
  // Buffer.from silently drops invalid hex characters rather than throwing,
  // so a garbage signature becomes a short buffer — the length check below
  // catches it, and timingSafeEqual is never handed mismatched lengths.
  const provided = Buffer.from(signature, 'hex')
  if (provided.length !== expected.length) return false

  return timingSafeEqual(provided, expected)
}
```

The comparison is `timingSafeEqual`, not `===`: string comparison returns early on the first differing byte, which leaks enough timing information to guess a signature byte by byte.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/webhook-signature.ts tests/unit/api/webhook-signature.test.ts
git commit -m "feat(api): add HMAC webhook signature signing and verification"
```

---

### Task 3: Payment library

**Files:**
- Create: `apps/api/src/lib/payment.ts`
- Test: `tests/unit/api/payment.test.ts`

**Interfaces:**
- Consumes `prisma`, `PAYMENT_PROVIDER`.
- Produces:
  - `createCheckoutSession(bookingId: string, userId: string)` → `{ providerRef, amount }`
  - `applyPaymentOutcome(input: { eventId: string; providerRef: string; outcome: 'succeeded' | 'failed' })` → `{ applied: boolean; bookingStatus?: string }`
  - Errors `BookingNotPayableError`, `PaymentNotFoundError`
- Consumed by Tasks 4 and 5.

- [ ] **Step 1: Write the failing test — `tests/unit/api/payment.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  bookingFindFirst: vi.fn(),
  paymentFindUnique: vi.fn(),
  paymentCreate: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: {
    booking: { findFirst: m.bookingFindFirst },
    payment: { findUnique: m.paymentFindUnique, create: m.paymentCreate },
    $transaction: m.transaction,
  },
}))

import {
  createCheckoutSession,
  applyPaymentOutcome,
  BookingNotPayableError,
} from '../../../apps/api/src/lib/payment'

beforeEach(() => vi.clearAllMocks())

describe('createCheckoutSession', () => {
  it('rejects a booking that is not the caller\'s', async () => {
    m.bookingFindFirst.mockResolvedValue(null)

    await expect(createCheckoutSession('b1', 'not-the-owner')).rejects.toThrow(
      BookingNotPayableError,
    )
    expect(m.paymentCreate).not.toHaveBeenCalled()
  })

  it('rejects a booking that is not PENDING_PAYMENT', async () => {
    m.bookingFindFirst.mockResolvedValue({
      id: 'b1',
      status: 'PAID',
      totalPrice: 4700,
      expiresAt: new Date(Date.now() + 60_000),
    })

    await expect(createCheckoutSession('b1', 'u1')).rejects.toThrow(BookingNotPayableError)
    expect(m.paymentCreate).not.toHaveBeenCalled()
  })

  it('rejects a booking whose hold already expired', async () => {
    m.bookingFindFirst.mockResolvedValue({
      id: 'b1',
      status: 'PENDING_PAYMENT',
      totalPrice: 4700,
      expiresAt: new Date(Date.now() - 1000),
    })

    await expect(createCheckoutSession('b1', 'u1')).rejects.toThrow(BookingNotPayableError)
  })

  it('takes the amount from the booking, not from anything a caller could supply', async () => {
    m.bookingFindFirst.mockResolvedValue({
      id: 'b1',
      status: 'PENDING_PAYMENT',
      totalPrice: 4700,
      expiresAt: new Date(Date.now() + 60_000),
    })
    m.paymentFindUnique.mockResolvedValue(null)
    m.paymentCreate.mockResolvedValue({ providerRef: 'ref_1', amount: 4700 })

    const result = await createCheckoutSession('b1', 'u1')

    expect(result.amount).toBe(4700)
    expect(m.paymentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 4700 }) }),
    )
  })

  // Clicking "pay" twice must not mint a second session.
  it('returns the existing session when a PENDING payment already exists', async () => {
    m.bookingFindFirst.mockResolvedValue({
      id: 'b1',
      status: 'PENDING_PAYMENT',
      totalPrice: 4700,
      expiresAt: new Date(Date.now() + 60_000),
    })
    m.paymentFindUnique.mockResolvedValue({ providerRef: 'ref_existing', amount: 4700, status: 'PENDING' })

    const result = await createCheckoutSession('b1', 'u1')

    expect(result.providerRef).toBe('ref_existing')
    expect(m.paymentCreate).not.toHaveBeenCalled()
  })
})

// Runs the callback against a stub transaction client.
function txRuns(tx: Record<string, unknown>) {
  m.transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx))
}

describe('applyPaymentOutcome', () => {
  it('is a no-op when the event id was already recorded', async () => {
    const bookingUpdate = vi.fn()
    txRuns({
      webhookEvent: {
        create: vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' })),
      },
      booking: { update: bookingUpdate },
    })

    const result = await applyPaymentOutcome({
      eventId: 'evt_1',
      providerRef: 'ref_1',
      outcome: 'succeeded',
    })

    expect(result.applied).toBe(false)
    expect(bookingUpdate).not.toHaveBeenCalled()
  })

  it('marks the payment FAILED and leaves the booking untouched on a failed outcome', async () => {
    const bookingUpdate = vi.fn()
    const paymentUpdate = vi.fn()
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          booking: { id: 'b1', status: 'PENDING_PAYMENT' },
        }),
        update: paymentUpdate,
      },
      booking: { update: bookingUpdate },
    })

    await applyPaymentOutcome({ eventId: 'evt_2', providerRef: 'ref_1', outcome: 'failed' })

    expect(paymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    )
    expect(bookingUpdate).not.toHaveBeenCalled()
  })

  it('marks a PENDING_PAYMENT booking PAID on success', async () => {
    const bookingUpdate = vi.fn()
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          booking: { id: 'b1', status: 'PENDING_PAYMENT' },
        }),
        update: vi.fn(),
      },
      booking: { update: bookingUpdate },
    })

    await applyPaymentOutcome({ eventId: 'evt_3', providerRef: 'ref_1', outcome: 'succeeded' })

    expect(bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PAID' }) }),
    )
  })

  it('recovers an expired booking when every seat is still free', async () => {
    const bookingUpdate = vi.fn()
    const seatUpdateMany = vi.fn()
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          booking: {
            id: 'b1',
            status: 'EXPIRED',
            seats: [{ seatId: 's1' }, { seatId: 's2' }],
          },
        }),
        update: vi.fn(),
      },
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 's1', status: 'AVAILABLE' },
        { id: 's2', status: 'AVAILABLE' },
      ]),
      seat: { updateMany: seatUpdateMany },
      booking: { update: bookingUpdate },
    })

    await applyPaymentOutcome({ eventId: 'evt_4', providerRef: 'ref_1', outcome: 'succeeded' })

    expect(seatUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'BOOKED' } }),
    )
    expect(bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PAID' }) }),
    )
  })

  // The money case: paid for, seats gone. Never take a seat from whoever holds it.
  it('flags REFUND_REQUIRED and does not touch seats when one was taken', async () => {
    const bookingUpdate = vi.fn()
    const seatUpdateMany = vi.fn()
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          booking: {
            id: 'b1',
            status: 'EXPIRED',
            seats: [{ seatId: 's1' }, { seatId: 's2' }],
          },
        }),
        update: vi.fn(),
      },
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 's1', status: 'AVAILABLE' },
        { id: 's2', status: 'BOOKED' },
      ]),
      seat: { updateMany: seatUpdateMany },
      booking: { update: bookingUpdate },
    })

    await applyPaymentOutcome({ eventId: 'evt_5', providerRef: 'ref_1', outcome: 'succeeded' })

    expect(seatUpdateMany).not.toHaveBeenCalled()
    expect(bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REFUND_REQUIRED' }) }),
    )
  })

  it('does nothing when the booking is already PAID', async () => {
    const bookingUpdate = vi.fn()
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          booking: { id: 'b1', status: 'PAID' },
        }),
        update: vi.fn(),
      },
      booking: { update: bookingUpdate },
    })

    await applyPaymentOutcome({ eventId: 'evt_6', providerRef: 'ref_1', outcome: 'succeeded' })

    expect(bookingUpdate).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/api && npx vitest run`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `apps/api/src/lib/payment.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { prisma } from './prisma.js'
import { PAYMENT_PROVIDER } from './config.js'

export class BookingNotPayableError extends Error {}
export class PaymentNotFoundError extends Error {}

// Creates (or returns) the provider session a user will pay against.
// Scoped by userId so a caller can only ever start checkout on their own
// booking; the route turns the resulting error into a 404, not a 403.
export async function createCheckoutSession(bookingId: string, userId: string) {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, userId } })
  if (!booking) throw new BookingNotPayableError()
  if (booking.status !== 'PENDING_PAYMENT') throw new BookingNotPayableError()
  if (booking.expiresAt <= new Date()) throw new BookingNotPayableError()

  // Clicking pay twice must not mint a second session — the seat hold and the
  // amount are unchanged, so the existing one is still the right one.
  const existing = await prisma.payment.findUnique({ where: { bookingId } })
  if (existing && existing.status === 'PENDING') {
    return { providerRef: existing.providerRef, amount: existing.amount }
  }

  const created = await prisma.payment.create({
    data: {
      bookingId,
      provider: PAYMENT_PROVIDER,
      providerRef: `sess_${randomUUID()}`,
      // From the database, never from the request.
      amount: booking.totalPrice,
      status: 'PENDING',
    },
  })
  return { providerRef: created.providerRef, amount: created.amount }
}

type SeatRow = { id: string; status: string }

export async function applyPaymentOutcome(input: {
  eventId: string
  providerRef: string
  outcome: 'succeeded' | 'failed'
}): Promise<{ applied: boolean; bookingStatus?: string }> {
  return await prisma.$transaction(async (tx) => {
    // Idempotency: the unique constraint is the arbiter, not a prior read.
    // A SELECT-then-INSERT would let two simultaneous deliveries both miss
    // and both apply the effect.
    try {
      await tx.webhookEvent.create({ data: { eventId: input.eventId } })
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002') {
        return { applied: false }
      }
      throw err
    }

    const payment = await tx.payment.findUnique({
      where: { providerRef: input.providerRef },
      include: { booking: { include: { seats: { select: { seatId: true } } } } },
    })
    if (!payment) throw new PaymentNotFoundError()

    if (input.outcome === 'failed') {
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } })
      // A failed charge never moves the booking in either direction — the
      // user can retry until the hold expires, and expiry is the sweep's job.
      return { applied: true, bookingStatus: payment.booking.status }
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'SUCCEEDED', paidAt: new Date() },
    })

    if (payment.booking.status === 'PAID') {
      return { applied: true, bookingStatus: 'PAID' }
    }

    if (payment.booking.status === 'PENDING_PAYMENT') {
      await tx.booking.update({ where: { id: payment.bookingId }, data: { status: 'PAID' } })
      return { applied: true, bookingStatus: 'PAID' }
    }

    // The money case: the hold lapsed before the webhook landed, the seats
    // were returned to the pool, and the user has already been charged.
    // Recover the booking if nobody took the seats; otherwise flag it for a
    // refund rather than taking a seat away from whoever holds it now.
    const seatIds = payment.booking.seats.map((s) => s.seatId)
    const seats = await tx.$queryRaw<SeatRow[]>`
      SELECT id, status::text AS status FROM "Seat"
      WHERE id = ANY(${seatIds}::text[])
      ORDER BY id
      FOR UPDATE
    `

    const allFree = seats.length === seatIds.length && seats.every((s) => s.status === 'AVAILABLE')
    if (allFree) {
      await tx.seat.updateMany({ where: { id: { in: seatIds } }, data: { status: 'BOOKED' } })
      await tx.booking.update({ where: { id: payment.bookingId }, data: { status: 'PAID' } })
      return { applied: true, bookingStatus: 'PAID' }
    }

    // LIMITATION: this only records that a refund is owed. Nothing pays it
    // back yet — Phase 5's admin panel must surface REFUND_REQUIRED bookings,
    // or a customer stays charged for seats they never got.
    await tx.booking.update({
      where: { id: payment.bookingId },
      data: { status: 'REFUND_REQUIRED' },
    })
    return { applied: true, bookingStatus: 'REFUND_REQUIRED' }
  })
}
```

`ORDER BY id` on the recovery lock, for the same reason as `createBooking`: one global lock order, or two transactions wanting the same seats deadlock.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/payment.ts tests/unit/api/payment.test.ts
git commit -m "feat(api): add checkout session creation and payment outcome application"
```

---

### Task 4: Webhook route and raw-body wiring

**Files:**
- Create: `apps/api/src/routes/webhooks.ts`
- Modify: `apps/api/src/index.ts`
- Test: `tests/unit/api/webhook-route.test.ts`

**Interfaces:**
- Produces `POST /webhooks/payment` and the exported `paymentWebhookHandler`.

- [ ] **Step 1: Create `apps/api/src/routes/webhooks.ts`**

```ts
import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { verifyWebhookSignature } from '../lib/webhook-signature.js'
import { applyPaymentOutcome } from '../lib/payment.js'
import { logServerError } from '../lib/log.js'

const router = Router()

const payloadSchema = z.object({
  eventId: z.string().min(1),
  providerRef: z.string().min(1),
  outcome: z.enum(['succeeded', 'failed']),
})

export const paymentWebhookHandler: RequestHandler = async (req, res) => {
  // req.body is a Buffer here — express.raw is mounted for this path in
  // index.ts, ahead of express.json. The signature covers the exact bytes
  // that arrived, so it must be checked before anything parses them.
  const rawBody: Buffer = req.body
  const signature = req.header('x-payment-signature')

  if (!Buffer.isBuffer(rawBody) || !verifyWebhookSignature(rawBody, signature)) {
    // Nothing is read from or written to the database on this path.
    return res.status(400).json({ error: 'Invalid signature' })
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return res.status(400).json({ error: 'Invalid payload' })
  }

  const parsed = payloadSchema.safeParse(parsedJson)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  try {
    const result = await applyPaymentOutcome(parsed.data)
    // 200 even when the event was a duplicate: a provider retries on any
    // non-2xx, and re-delivering something already handled helps nobody.
    return res.json({ received: true, applied: result.applied })
  } catch (err) {
    logServerError('POST /webhooks/payment failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

router.post('/payment', paymentWebhookHandler)

export default router
```

- [ ] **Step 2: Wire the raw body in `apps/api/src/index.ts`**

The `express.raw` mount must come **before** `express.json()`, or the JSON parser consumes the stream and leaves nothing to verify:

```ts
import webhooksRouter from './routes/webhooks.js'
import { assertPaymentProviderIsSafe } from './lib/config.js'

assertPaymentProviderIsSafe()

// ...after cors, BEFORE express.json():
app.use('/webhooks', express.raw({ type: 'application/json' }))
app.use(express.json())
// ...
app.use('/webhooks', webhooksRouter)
```

- [ ] **Step 3: Write the route test — `tests/unit/api/webhook-route.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ apply: vi.fn() }))
vi.mock('../../../apps/api/src/lib/payment', () => ({ applyPaymentOutcome: m.apply }))

import { paymentWebhookHandler } from '../../../apps/api/src/routes/webhooks'
import { signWebhookPayload } from '../../../apps/api/src/lib/webhook-signature'

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() } as any
  res.status.mockReturnValue(res)
  res.json.mockReturnValue(res)
  return res
}

function makeReq(body: Buffer, signature?: string) {
  return { body, header: (name: string) => (name === 'x-payment-signature' ? signature : undefined) } as any
}

const payload = { eventId: 'evt_1', providerRef: 'ref_1', outcome: 'succeeded' as const }
const raw = Buffer.from(JSON.stringify(payload))

beforeEach(() => {
  vi.clearAllMocks()
  m.apply.mockResolvedValue({ applied: true })
})

describe('paymentWebhookHandler', () => {
  it('rejects a request with no signature and never touches the payment layer', async () => {
    const res = makeRes()
    await paymentWebhookHandler(makeReq(raw), res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(m.apply).not.toHaveBeenCalled()
  })

  it('rejects a forged signature', async () => {
    const res = makeRes()
    await paymentWebhookHandler(makeReq(raw, 'deadbeef'), res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(m.apply).not.toHaveBeenCalled()
  })

  // Signed one payload, sent another.
  it('rejects a body altered after signing', async () => {
    const signature = signWebhookPayload(raw)
    const tampered = Buffer.from(JSON.stringify({ ...payload, outcome: 'failed' }))
    const res = makeRes()

    await paymentWebhookHandler(makeReq(tampered, signature), res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(m.apply).not.toHaveBeenCalled()
  })

  it('accepts a correctly signed payload', async () => {
    const res = makeRes()
    await paymentWebhookHandler(makeReq(raw, signWebhookPayload(raw)), res, vi.fn())

    expect(m.apply).toHaveBeenCalledWith(payload)
    expect(res.json).toHaveBeenCalledWith({ received: true, applied: true })
  })

  it('returns 200 for a duplicate event rather than a retryable error', async () => {
    m.apply.mockResolvedValue({ applied: false })
    const res = makeRes()

    await paymentWebhookHandler(makeReq(raw, signWebhookPayload(raw)), res, vi.fn())

    expect(res.status).not.toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ received: true, applied: false })
  })
})
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/webhooks.ts apps/api/src/index.ts tests/unit/api/webhook-route.test.ts
git commit -m "feat(api): add signed payment webhook with raw-body verification"
```

---

### Task 5: Checkout route and the mock provider

**Files:**
- Modify: `apps/api/src/routes/bookings.ts`
- Create: `apps/api/src/routes/mock-provider.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Produces `POST /bookings/:id/checkout` and `POST /mock-provider/sessions/:providerRef/complete`.

- [ ] **Step 1: Add the checkout handler to `apps/api/src/routes/bookings.ts`**

```ts
import { createCheckoutSession, BookingNotPayableError } from '../lib/payment.js'
import { PAYMENT_PROVIDER, FRONTEND_ORIGIN } from '../lib/config.js'

export const checkoutHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' })

  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const session = await createCheckoutSession(id, userId)
    return res.status(201).json({
      providerRef: session.providerRef,
      amount: session.amount,
      // Where the user goes to pay. With a real provider this would be the
      // provider's hosted page; the mock's stands in for it.
      checkoutUrl: `${FRONTEND_ORIGIN}/mock-pay/${session.providerRef}`,
      provider: PAYMENT_PROVIDER,
    })
  } catch (err) {
    // Covers "not yours", "not pending", and "hold expired" alike — the
    // caller learns only that it cannot be paid, not which of those it is.
    if (err instanceof BookingNotPayableError) {
      return res.status(409).json({ error: 'This booking cannot be paid for' })
    }
    logServerError('POST /bookings/:id/checkout failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

router.post('/:id/checkout', requireAuth, checkoutHandler)
```

- [ ] **Step 2: Create `apps/api/src/routes/mock-provider.ts`**

```ts
import { Router, type RequestHandler } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { signWebhookPayload } from '../lib/webhook-signature.js'
import { API_BASE_URL } from '../lib/config.js'
import { logServerError } from '../lib/log.js'

const router = Router()

const completeSchema = z.object({ outcome: z.enum(['succeeded', 'failed']) })

// Stands in for a payment provider's hosted checkout. It deliberately posts a
// signed webhook over real HTTP rather than calling applyPaymentOutcome
// directly: routing through the wire is the only way the signature check and
// the raw-body handling are actually exercised.
//
// index.ts mounts this router ONLY when PAYMENT_PROVIDER === 'mock', and
// config.assertPaymentProviderIsSafe() refuses to boot with the mock in
// production — this endpoint marks bookings paid with no money involved.
export const completeSessionHandler: RequestHandler = async (req, res) => {
  const { providerRef } = req.params
  if (typeof providerRef !== 'string') return res.status(400).json({ error: 'Invalid session' })

  const parsed = completeSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  try {
    const payment = await prisma.payment.findUnique({ where: { providerRef } })
    if (!payment) return res.status(404).json({ error: 'Session not found' })

    const body = JSON.stringify({
      eventId: `evt_${randomUUID()}`,
      providerRef,
      outcome: parsed.data.outcome,
    })

    const response = await fetch(`${API_BASE_URL}/webhooks/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-payment-signature': signWebhookPayload(body),
      },
      body,
    })

    if (!response.ok) {
      logServerError('mock provider webhook delivery failed', new Error(`status ${response.status}`))
      return res.status(502).json({ error: 'Webhook delivery failed' })
    }

    // bookingId goes back so the payment page can redirect the user to their
    // booking — the page only ever knows the providerRef.
    return res.json({ delivered: true, bookingId: payment.bookingId })
  } catch (err) {
    logServerError('POST /mock-provider/sessions/:ref/complete failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

router.post('/sessions/:providerRef/complete', completeSessionHandler)

export default router
```

- [ ] **Step 3: Mount it conditionally in `apps/api/src/index.ts`**

```ts
import { PAYMENT_PROVIDER } from './lib/config.js'

// Mounted only for the mock provider. Not mounted-then-guarded: a route that
// does not exist cannot be reached by a misconfiguration.
if (PAYMENT_PROVIDER === 'mock') {
  const { default: mockProviderRouter } = await import('./routes/mock-provider.js')
  app.use('/mock-provider', mockProviderRouter)
}
```

If a top-level `await` is awkward in this file, a static import plus an `if` around only the `app.use(...)` is acceptable — the requirement is that the route is not registered when the provider is not `mock`.

- [ ] **Step 4: Verify by hand against the running stack**

Run (Postgres and Redis up, database seeded, nothing on port 4000):

```bash
cd apps/api && npx tsx src/index.ts &
sleep 3
# register, log in, hold a seat, then:
#   POST /bookings/<id>/checkout   -> 201 with providerRef and checkoutUrl
#   POST /mock-provider/sessions/<ref>/complete { "outcome": "succeeded" } -> { delivered: true }
#   GET  /bookings/<id>            -> status PAID
# then re-run the complete call and confirm the booking is still PAID with one Payment row.
kill %1
```

Paste the real output.

- [ ] **Step 5: Confirm the route disappears when the provider is not mock**

Run: `cd apps/api && PAYMENT_PROVIDER=stripe npx tsx src/index.ts &` then
`curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:4000/mock-provider/sessions/x/complete -H 'Content-Type: application/json' -d '{"outcome":"succeeded"}'`
Expected: **404**. Kill the server afterward.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/bookings.ts apps/api/src/routes/mock-provider.ts apps/api/src/index.ts
git commit -m "feat(api): add checkout endpoint and mock payment provider"
```

---

### Task 6: Integration test — duplicate and concurrent webhook delivery

**Files:**
- Create: `tests/integration/payment-idempotency.test.ts`

- [ ] **Step 1: Write the test**

It must own its fixtures the way `tests/integration/helpers.ts` already does for the seat tests — **read that file first** and reuse `createFixture`/`deleteFixture`, extending them so the fixture also creates a `Booking` (with `BookingSeat` rows) and a `PENDING` `Payment`, and deletes them again children-first. Never touch seeded data.

```ts
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { prisma } from '../../apps/api/src/lib/prisma'
import { applyPaymentOutcome } from '../../apps/api/src/lib/payment'
// createFixture/deleteFixture come from ./helpers — extend them per the note above.
import { createFixture, deleteFixture, type TestFixture } from './helpers'

let fixture: TestFixture

beforeEach(async () => {
  fixture = await createFixture({ withBooking: true, withPendingPayment: true })
})

afterEach(async () => {
  await prisma.webhookEvent.deleteMany({ where: { eventId: { startsWith: 'evt_test_' } } })
  await deleteFixture(fixture)
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('webhook idempotency', () => {
  it('applies a repeated delivery exactly once', async () => {
    const eventId = `evt_test_${Date.now()}_seq`
    const input = { eventId, providerRef: fixture.providerRef, outcome: 'succeeded' as const }

    const first = await applyPaymentOutcome(input)
    const paidAtAfterFirst = (
      await prisma.payment.findUniqueOrThrow({ where: { providerRef: fixture.providerRef } })
    ).paidAt

    const second = await applyPaymentOutcome(input)

    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { providerRef: fixture.providerRef },
    })
    expect(payment.status).toBe('SUCCEEDED')
    // A second application would stamp a new time.
    expect(payment.paidAt?.getTime()).toBe(paidAtAfterFirst?.getTime())

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: fixture.bookingId } })
    expect(booking.status).toBe('PAID')
    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(1)
  })

  // The one that matters. A sequential duplicate check passes even when
  // idempotency is a SELECT-then-INSERT, because each call finishes before the
  // next begins — the same blind spot that let a broken rate limiter and a
  // mis-targeted concurrency test through in earlier phases.
  it('applies exactly once when the same event arrives ten times at once', async () => {
    const eventId = `evt_test_${Date.now()}_par`
    const input = { eventId, providerRef: fixture.providerRef, outcome: 'succeeded' as const }

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => applyPaymentOutcome(input)),
    )

    const applied = results.filter((r) => r.status === 'fulfilled' && r.value.applied === true)
    expect(applied).toHaveLength(1)

    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(1)

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: fixture.bookingId } })
    expect(booking.status).toBe('PAID')

    const payments = await prisma.payment.findMany({ where: { bookingId: fixture.bookingId } })
    expect(payments).toHaveLength(1)
    expect(payments[0].status).toBe('SUCCEEDED')
  })
})
```

Note the parallel case may surface losers as rejections rather than `applied: false`, depending on how Postgres reports the unique violation under contention — the assertion deliberately counts only the winners, so either shape passes as long as exactly one applied.

- [ ] **Step 2: Run it**

Run: `docker compose up -d postgres redis && cd apps/api && npm run test:integration`
Expected: all integration tests pass (the 2 seat ones plus these).

If more than one parallel delivery applies the effect, STOP and report — that is the idempotency bug this task exists to catch.

- [ ] **Step 3: Confirm the unit suite still needs no services**

Run: `docker compose stop postgres redis && cd apps/api && npx vitest run && docker compose start postgres redis`
Expected: unit suite passes.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/payment-idempotency.test.ts
git commit -m "test(api): prove webhook idempotency under duplicate and concurrent delivery"
```

---

### Task 7: Frontend — mock payment page and booking page updates

**Files:**
- Create: `apps/web/app/mock-pay/[ref]/page.tsx`
- Modify: `apps/web/app/bookings/[id]/page.tsx`

- [ ] **Step 1: Create the mock payment page**

A client component at `/mock-pay/[ref]`. It is the stand-in for a provider's hosted checkout, so it does **not** require login and shows only the amount — no personal data. Read `apps/web/app/showtimes/[id]/seats/seat-picker.tsx` for the house conventions (Thai copy, `apiFetch`, disabled-while-submitting, error handling that distinguishes a thrown fetch from a non-ok response).

It needs: the amount (fetch it from the checkout response passed through, or a small public endpoint — choose the simpler and say which), two buttons (`จ่ายเงินสำเร็จ` / `จ่ายเงินไม่สำเร็จ`), and on completion a redirect back to `/bookings/[id]`.

`POST /mock-provider/sessions/:ref/complete` already returns `{ delivered: true, bookingId }` (Task 5), so redirect to `/bookings/${bookingId}` on success.

For the amount, the simplest option is a small public read on the mock route — `GET /mock-provider/sessions/:ref` returning `{ amount }` — since the page has no session of its own. Add it beside the complete handler, returning 404 for an unknown ref, and exposing nothing but the amount.

- [ ] **Step 2: Update the booking page**

`apps/web/app/bookings/[id]/page.tsx` currently ends with a note that payment arrives in a later phase. Replace it with:
- when `status === 'PENDING_PAYMENT'`: a `ไปชำระเงิน` button that calls `POST /bookings/:id/checkout` via `apiFetch` and redirects to the returned `checkoutUrl`
- when `PAID`: a Thai confirmation
- when `EXPIRED`: a Thai expired message
- when `REFUND_REQUIRED`: a Thai message explaining the payment succeeded but the seats were taken, and that staff will arrange a refund

Handle the checkout call's error paths as the seat picker does: `401` → `/login`, `409` → a Thai message, thrown fetch → a Thai connection message.

- [ ] **Step 3: Verify**

Run: `cd apps/web && npx next build && npx tsc --noEmit`, then `npm run build` and `npm test` from the root.
Expected: clean; `/mock-pay/[ref]` appears in the route list.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/mock-pay apps/web/app/bookings
git commit -m "feat(web): add mock payment page and booking payment actions"
```

---

### Task 8: Full verification pass

**Files:** none — verification only.

- [ ] **Step 1: Root build and unit suite**

Run: `npm run build && npm test`
Expected: both clean; the route list includes `/mock-pay/[ref]`.

- [ ] **Step 2: Integration suite**

Run: `docker compose up -d postgres redis && cd apps/api && npx prisma db seed && npm run test:integration`
Expected: all pass.

- [ ] **Step 3: End-to-end click-through**

With both dev servers running and seeded data, in a browser: log in → pick seats → book → on the booking page click ไปชำระเงิน → land on the mock payment page → click จ่ายเงินสำเร็จ → return to the booking page showing `PAID`.

Then repeat and click จ่ายเงินไม่สำเร็จ, confirming the booking stays `PENDING_PAYMENT` and can be paid on a second attempt.

- [ ] **Step 4: Security spot-checks**

```bash
# forged signature must be rejected, with nothing written
curl -si -X POST http://localhost:4000/webhooks/payment \
  -H 'Content-Type: application/json' -H 'x-payment-signature: deadbeef' \
  -d '{"eventId":"evt_fake","providerRef":"ref_x","outcome":"succeeded"}'
# expect 400

# no signature at all
curl -si -X POST http://localhost:4000/webhooks/payment \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"evt_fake2","providerRef":"ref_x","outcome":"succeeded"}'
# expect 400

# someone else's booking cannot be checked out
# expect 409 (or 404 if the booking is not theirs)
```

- [ ] **Step 5: Report**

Summarize what was built, what was deliberately skipped (real refunds, tickets, Stripe), and what a human should review before Phase 4 — in particular that `REFUND_REQUIRED` bookings have no handling yet.

---

## End-of-phase notes

- The mock provider is a demonstration seam, not a shortcut: it signs and delivers over HTTP so the signature check and raw-body handling are genuinely exercised. Swapping in a real provider should mean replacing `mock-provider.ts` and the `checkoutUrl`, nothing else.
- `REFUND_REQUIRED` records a debt the system cannot yet settle. Phase 5's admin panel must surface it.
- Idempotency rests entirely on `WebhookEvent.eventId` being unique and inserted in the same transaction as the effect. Any refactor that moves that insert outside the transaction, or replaces it with a prior read, reintroduces the race.
