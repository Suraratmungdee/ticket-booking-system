# Phase 4 — Ticket Issuance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A booking that reaches `PAID` gets a `Ticket` row in the same transaction, carrying an HMAC-signed QR payload the user can view at `/me/tickets/[id]`, plus a best-effort confirmation email.

**Architecture:** `Ticket.bookingId @unique` is the whole idempotency mechanism — `issueTicket` inserts and swallows `P2002`, so a duplicate webhook delivery cannot mint a second ticket. The QR payload is `<ticketId>.<hmac-sha256>` signed with a secret separate from the payment webhook's. Email is fire-and-forget **after** the transaction commits, so a dead mail provider can never turn a successful payment into a webhook 500 and a retry storm.

**Spec:** `docs/superpowers/specs/2026-08-12-phase4-ticket-issuance-design.md` — read it before starting.

**Tech Stack:** Express 5 + TypeScript (ESM/NodeNext), Prisma v6, PostgreSQL, Next.js 16, Tailwind v4, Vitest, `node:crypto`, `qrcode`.

## Global Constraints

- npm workspaces: `apps/api` owns all business logic and DB access; `apps/web` is UI only. **No business logic in `apps/web`** — it calls the API and renders.
- `apps/api/src` is ESM/NodeNext — **every relative import needs a `.js` extension**. Files under `tests/` must NOT have them. `apps/web` uses bundler resolution — no extensions.
- All business constants live in `apps/api/src/lib/config.ts`. Never hardcode a secret name, TTL, or URL in two places.
- Business logic lives in `apps/api/src/lib` as shared functions; routes are thin adapters matching `apps/api/src/routes/bookings.ts` (named exported handlers; `try/catch` → `logServerError(...)` → generic `500 { error: 'Internal server error' }`).
- **Not-owner returns `404`, never `403`.** A 403 confirms the id exists.
- State changes happen in ONE transaction. Never split them.
- **One new dependency only: `qrcode` (+ `@types/qrcode`) in `apps/api`.** It is named in `CLAUDE.md` §2's approved stack, so it is not a new decision. **Adding anything else requires asking the user first.**
- Migrations are additive. No `DROP` without approval. The local Postgres is shared by every worktree — a migration applied here changes what every other worktree sees.
- No secrets committed; `.env` is gitignored, `.env.example` carries placeholders only.
- Deliberate corner-cuts carry a `// ponytail:` or `// LIMITATION:` comment naming the ceiling and the upgrade trigger.
- Branching logic needs at least one test that genuinely fails if the logic breaks.
- **Current baseline: root `npm run build` clean, `npm test` = 100 unit tests across 12 files, `cd apps/api && npm run test:integration` = 4 tests. All must keep passing.**

## Correction to the spec

The spec says the ticket link goes on `/bookings/[id]/success`. **That page does not exist** — `apps/web/app/mock-pay/[ref]/page.tsx` redirects to `/bookings/[id]` after payment. Task 6 puts the link on `/bookings/[id]` instead. Do not create a success page.

---

### Task 1: Schema, config, and the production secret guard

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/lib/config.ts`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/.env` (local only, not committed)
- Test: `tests/unit/api/config-guard.test.ts`

**Interfaces:**
- Produces model `Ticket` and back-relation `Booking.ticket`.
- Produces `config.ts` exports `TICKET_SIGNING_SECRET: string`, `RESEND_API_KEY: string | undefined`, `EMAIL_FROM: string`, and extends `assertPaymentProviderIsSafe()` with two new production checks.

- [ ] **Step 1: Append the model to `apps/api/prisma/schema.prisma`**

```prisma
// One ticket per booking (a booking already holds N seats). bookingId is
// @unique for the same reason WebhookEvent.eventId is: a duplicate webhook
// delivery must lose to the constraint rather than mint a second ticket.
// Checking "does a ticket exist" before inserting is a check-then-act race
// under parallel delivery — the constraint is the only thing that holds.
model Ticket {
  id            String   @id @default(cuid())
  bookingId     String   @unique
  booking       Booking  @relation(fields: [bookingId], references: [id])
  // Stored rather than recomputed on read: if the signing secret is ever
  // rotated, tickets already handed out must stay readable.
  qrCodePayload String
  issuedAt      DateTime @default(now())
}
```

Add the back-relation to the existing `Booking` model (leave every other field untouched):

```prisma
model Booking {
  // ...existing fields unchanged...
  ticket     Ticket?
}
```

- [ ] **Step 2: Append to `apps/api/src/lib/config.ts`**

```ts
// Signs the QR payload on a ticket. Deliberately NOT the same value as
// PAYMENT_WEBHOOK_SECRET: those are two different trust boundaries, and
// whoever gets one leaked must not be able to forge the other.
//
// LIMITATION: falls back to a dev-only value committed in this repo (so it
// is not a secret) to keep local boot working without a .env. The guard in
// assertPaymentProviderIsSafe below makes that fallback unreachable in
// production.
const DEV_TICKET_SECRET_FALLBACK = 'dev-ticket-secret-change-me'
export const TICKET_SIGNING_SECRET =
  process.env.TICKET_SIGNING_SECRET ?? DEV_TICKET_SECRET_FALLBACK

// Confirmation email. Unset is a supported state: lib/email.ts logs the
// message instead of sending it, so local dev needs no mail account.
export const RESEND_API_KEY = process.env.RESEND_API_KEY
export const EMAIL_FROM = process.env.EMAIL_FROM ?? 'tickets@example.com'
```

Then extend the **existing** `assertPaymentProviderIsSafe()` function by adding these two checks before its closing brace. Do not create a second guard function — one boot guard, called once from `index.ts`:

```ts
  // Same failure Phase 3 had to be patched for: a deploy that copied
  // .env.example verbatim would boot with a publicly known signing key,
  // letting anyone mint a valid-looking ticket QR for free.
  if (process.env.NODE_ENV === 'production' && !process.env.TICKET_SIGNING_SECRET) {
    throw new Error('TICKET_SIGNING_SECRET must be set when NODE_ENV=production')
  }
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.TICKET_SIGNING_SECRET === DEV_TICKET_SECRET_FALLBACK
  ) {
    throw new Error(
      'TICKET_SIGNING_SECRET is still the committed .env.example placeholder — set a real secret before deploying to production.',
    )
  }
```

- [ ] **Step 3: Append to `apps/api/.env.example`**

```
TICKET_SIGNING_SECRET="dev-ticket-secret-change-me"
RESEND_API_KEY=""
EMAIL_FROM="tickets@example.com"
```

Add the same three lines to your local `apps/api/.env` (gitignored). Leave `RESEND_API_KEY` empty — the email adapter is designed to run without it.

- [ ] **Step 4: Write the failing guard tests**

Append to `tests/unit/api/config-guard.test.ts`. Read the top of that file first and follow its existing pattern for resetting `process.env` and re-importing the module — do not invent a different one.

```ts
describe('assertPaymentProviderIsSafe — ticket signing secret', () => {
  it('refuses to boot in production without TICKET_SIGNING_SECRET', async () => {
    process.env.NODE_ENV = 'production'
    process.env.PAYMENT_PROVIDER = 'stripe'
    process.env.PAYMENT_WEBHOOK_SECRET = 'a-real-webhook-secret'
    delete process.env.TICKET_SIGNING_SECRET

    const { assertPaymentProviderIsSafe } = await import('../../../apps/api/src/lib/config')
    expect(() => assertPaymentProviderIsSafe()).toThrow(/TICKET_SIGNING_SECRET/)
  })

  it('refuses to boot in production with the committed placeholder secret', async () => {
    process.env.NODE_ENV = 'production'
    process.env.PAYMENT_PROVIDER = 'stripe'
    process.env.PAYMENT_WEBHOOK_SECRET = 'a-real-webhook-secret'
    process.env.TICKET_SIGNING_SECRET = 'dev-ticket-secret-change-me'

    const { assertPaymentProviderIsSafe } = await import('../../../apps/api/src/lib/config')
    expect(() => assertPaymentProviderIsSafe()).toThrow(/placeholder/)
  })

  it('boots in production with a real secret', async () => {
    process.env.NODE_ENV = 'production'
    process.env.PAYMENT_PROVIDER = 'stripe'
    process.env.PAYMENT_WEBHOOK_SECRET = 'a-real-webhook-secret'
    process.env.TICKET_SIGNING_SECRET = 'a-real-ticket-secret'

    const { assertPaymentProviderIsSafe } = await import('../../../apps/api/src/lib/config')
    expect(() => assertPaymentProviderIsSafe()).not.toThrow()
  })
})
```

- [ ] **Step 5: Run the tests, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/config-guard.test.ts`
Expected: the two new throw-cases FAIL (nothing throws yet) before Step 2 is in place; after Step 2 they pass. If you did Step 2 first, revert it mentally — confirm by temporarily commenting the new checks out, seeing red, then restoring.

- [ ] **Step 6: Create the migration**

```bash
cd apps/api && npx prisma migrate dev --name add_ticket
```

This writes `apps/api/prisma/migrations/<timestamp>_add_ticket/migration.sql` and applies it to the shared local Postgres. **Open the generated SQL and confirm it contains only `CREATE TABLE "Ticket"` and `CREATE UNIQUE INDEX`.** If it contains any `DROP`, stop and report to the user — do not apply it.

- [ ] **Step 7: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS, 103 unit tests, no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/src/lib/config.ts apps/api/.env.example tests/unit/api/config-guard.test.ts
git commit -m "feat(api): add Ticket model, signing secret, and production guard"
```

---

### Task 2: Sign and verify the QR payload

**Files:**
- Create: `apps/api/src/lib/ticket.ts`
- Test: `tests/unit/api/ticket-payload.test.ts`

**Interfaces:**
- Consumes: `TICKET_SIGNING_SECRET` from Task 1.
- Produces: `signTicketPayload(ticketId: string): string` returning `"<ticketId>.<64-hex>"`, and `verifyTicketPayload(payload: string): string | null` returning the ticketId on success and `null` on any failure.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api/ticket-payload.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { signTicketPayload, verifyTicketPayload } from '../../../apps/api/src/lib/ticket'

describe('ticket payload signing', () => {
  it('round-trips a ticket id', () => {
    const payload = signTicketPayload('tkt_abc')
    expect(verifyTicketPayload(payload)).toBe('tkt_abc')
  })

  it('produces id.signature with a 64-hex signature', () => {
    const payload = signTicketPayload('tkt_abc')
    const [id, sig] = payload.split('.')
    expect(id).toBe('tkt_abc')
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a payload whose ticket id was swapped', () => {
    const payload = signTicketPayload('tkt_abc')
    const sig = payload.split('.')[1]
    expect(verifyTicketPayload(`tkt_someone_elses.${sig}`)).toBeNull()
  })

  it('rejects a tampered signature', () => {
    const payload = signTicketPayload('tkt_abc')
    const [id, sig] = payload.split('.')
    const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1)
    expect(verifyTicketPayload(`${id}.${flipped}`)).toBeNull()
  })

  // The exact bug Phase 3 shipped and had to fix in webhook-signature.ts:
  // Buffer.from(hex) stops decoding at the first invalid pair instead of
  // throwing, so a valid signature with garbage appended decodes to the
  // same bytes and passes unless the whole string is validated first.
  it('rejects a valid signature with garbage appended', () => {
    const payload = signTicketPayload('tkt_abc')
    expect(verifyTicketPayload(`${payload}zzzz`)).toBeNull()
  })

  it('rejects a payload with no separator', () => {
    expect(verifyTicketPayload('tkt_abc')).toBeNull()
  })

  it('rejects an empty payload', () => {
    expect(verifyTicketPayload('')).toBeNull()
  })

  // A ticket id may not contain a dot, so extra dots mean the payload was
  // assembled by someone other than us.
  it('rejects a payload with extra separators', () => {
    const payload = signTicketPayload('tkt_abc')
    expect(verifyTicketPayload(`extra.${payload}`)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/ticket-payload.test.ts`
Expected: FAIL — `Failed to resolve import ".../lib/ticket"`.

- [ ] **Step 3: Create `apps/api/src/lib/ticket.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'
import { TICKET_SIGNING_SECRET } from './config.js'

// The QR carries "<ticketId>.<hmac>" so a scanner can tell a forged code
// from a real one without a database round-trip. Signed with a secret
// distinct from the payment webhook's — see config.ts.
export function signTicketPayload(ticketId: string): string {
  const signature = createHmac('sha256', TICKET_SIGNING_SECRET).update(ticketId).digest('hex')
  return `${ticketId}.${signature}`
}

// Returns the ticketId when the signature is ours, null otherwise. Every
// rejection returns the same null — the caller learns nothing about which
// part was wrong.
export function verifyTicketPayload(payload: string): string | null {
  const parts = payload.split('.')
  // Exactly two parts. A ticket id never contains a dot, so anything else
  // was assembled by someone other than us.
  if (parts.length !== 2) return null
  const [ticketId, signature] = parts
  if (!ticketId || !signature) return null

  // Validate the whole string as hex BEFORE decoding. Buffer.from stops at
  // the first invalid pair rather than rejecting, so a correct 64-char
  // signature with garbage appended would otherwise decode to the same
  // bytes and pass. This is the bug webhook-signature.ts already had to fix.
  if (!/^[0-9a-f]{64}$/i.test(signature)) return null

  const expected = Buffer.from(
    createHmac('sha256', TICKET_SIGNING_SECRET).update(ticketId).digest('hex'),
    'hex',
  )
  const provided = Buffer.from(signature, 'hex')
  // timingSafeEqual throws on mismatched lengths; the regex above already
  // guarantees they match, but this does not rely on that alone.
  if (provided.length !== expected.length) return null

  return timingSafeEqual(provided, expected) ? ticketId : null
}
```

- [ ] **Step 4: Run the tests, expect pass**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/ticket-payload.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove the hex check earns its place**

Temporarily delete the `if (!/^[0-9a-f]{64}$/i.test(signature)) return null` line and re-run. The "garbage appended" test must FAIL. Restore the line and confirm green again. This is the check the test exists for — if removing it leaves the suite green, the test is worthless and must be fixed.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/ticket.ts tests/unit/api/ticket-payload.test.ts
git commit -m "feat(api): add HMAC-signed ticket QR payload"
```

---

### Task 3: Issue the ticket inside the payment transaction

**Files:**
- Modify: `apps/api/src/lib/ticket.ts`
- Modify: `apps/api/src/lib/payment.ts`
- Test: `tests/unit/api/ticket-issue.test.ts`
- Test: `tests/unit/api/payment.test.ts` (extend)

**Interfaces:**
- Consumes: `signTicketPayload` from Task 2.
- Produces: `issueTicket(tx: Prisma.TransactionClient, bookingId: string): Promise<void>` — creates the ticket, silently returns if one already exists.
- Produces: `applyPaymentOutcome` return type gains `bookingId?: string`, which Task 4's webhook route consumes.

- [ ] **Step 1: Write the failing test for `issueTicket`**

Create `tests/unit/api/ticket-issue.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { issueTicket, verifyTicketPayload } from '../../../apps/api/src/lib/ticket'

function fakeTx(create: ReturnType<typeof vi.fn>) {
  return { ticket: { create } } as never
}

beforeEach(() => vi.clearAllMocks())

describe('issueTicket', () => {
  it('creates a ticket whose payload verifies back to its own id', async () => {
    const create = vi.fn().mockResolvedValue({})
    await issueTicket(fakeTx(create), 'b1')

    expect(create).toHaveBeenCalledTimes(1)
    const { data } = create.mock.calls[0][0]
    expect(data.bookingId).toBe('b1')
    // The signature must cover the id actually stored on the row, or a
    // scanner would verify a payload that points at a different ticket.
    expect(verifyTicketPayload(data.qrCodePayload)).toBe(data.id)
  })

  it('is a no-op when a ticket already exists (duplicate webhook delivery)', async () => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }))
    await expect(issueTicket(fakeTx(create), 'b1')).resolves.toBeUndefined()
  })

  it('propagates errors that are not a unique-constraint violation', async () => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'P1001' }))
    await expect(issueTicket(fakeTx(create), 'b1')).rejects.toThrow('boom')
  })
})
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/ticket-issue.test.ts`
Expected: FAIL — `issueTicket is not a function`.

- [ ] **Step 3: Append `issueTicket` to `apps/api/src/lib/ticket.ts`**

```ts
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
```

(add those to the existing imports at the top of the file, then append:)

```ts
// Issues the single ticket for a booking. Called inside the same
// transaction that moves the booking to PAID, so "PAID" and "has a ticket"
// can never disagree.
//
// The id is generated here rather than left to @default(cuid()): the
// payload signs the id, so the id has to exist before the row is written.
//
// A duplicate webhook delivery loses to bookingId's unique constraint and
// returns quietly. Reading first and inserting only if absent would be a
// check-then-act race — two parallel deliveries would both see nothing.
export async function issueTicket(
  tx: Prisma.TransactionClient,
  bookingId: string,
): Promise<void> {
  const id = randomUUID()
  try {
    await tx.ticket.create({
      data: { id, bookingId, qrCodePayload: signTicketPayload(id) },
    })
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002') return
    throw err
  }
}
```

- [ ] **Step 4: Run the tests, expect pass**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/ticket-issue.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Give the shared transaction stub a ticket client**

`tests/unit/api/payment.test.ts` builds its transaction client through one helper at line ~215. Every existing test that reaches a PAID path will start calling `tx.ticket.create` once Step 8 lands, so the stub has to provide it — patching only the new tests would leave three existing ones throwing `Cannot read properties of undefined`.

Add `ticketCreate: vi.fn()` to the file's existing `vi.hoisted` object `m`, then change the helper to seed the ticket client by default while still letting a test override it:

```ts
// Runs the callback against a stub transaction client. `ticket` is seeded
// by default because every PAID path issues one — a test that cares asserts
// on m.ticketCreate; a test that does not gets a working stub for free.
function txRuns(tx: Record<string, unknown>) {
  m.transaction.mockImplementation(async (fn: (t: unknown) => unknown) =>
    fn({ ticket: { create: m.ticketCreate }, ...tx }),
  )
}
```

- [ ] **Step 6: Write the failing tests for the wiring into `applyPaymentOutcome`**

Append to `tests/unit/api/payment.test.ts`, inside the existing `describe('applyPaymentOutcome', ...)` block or directly after it:

```ts
describe('applyPaymentOutcome — ticket issuance', () => {
  it('issues a ticket when a PENDING_PAYMENT booking becomes PAID', async () => {
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          status: 'PENDING',
          booking: { id: 'b1', status: 'PENDING_PAYMENT' },
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      booking: { update: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    })

    const result = await applyPaymentOutcome({
      eventId: 'evt_t1',
      providerRef: 'ref_1',
      outcome: 'succeeded',
    })

    expect(result.bookingStatus).toBe('PAID')
    expect(m.ticketCreate).toHaveBeenCalledTimes(1)
    expect(m.ticketCreate.mock.calls[0][0].data.bookingId).toBe('b1')
  })

  // The recover path: the hold lapsed, the sweep won the CAS, but the seats
  // are still free. This booking becomes PAID too, so it needs a ticket by
  // the same rule — a second code path is exactly where one gets forgotten.
  it('issues a ticket on the recover path when the seats are still free', async () => {
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          status: 'PENDING',
          booking: {
            id: 'b1',
            status: 'PENDING_PAYMENT',
            seats: [{ seatId: 's1' }, { seatId: 's2' }],
          },
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 's1', status: 'AVAILABLE' },
        { id: 's2', status: 'AVAILABLE' },
      ]),
      seat: { updateMany: vi.fn() },
      booking: { update: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    })

    const result = await applyPaymentOutcome({
      eventId: 'evt_t2',
      providerRef: 'ref_1',
      outcome: 'succeeded',
    })

    expect(result.bookingStatus).toBe('PAID')
    expect(m.ticketCreate).toHaveBeenCalledTimes(1)
    expect(m.ticketCreate.mock.calls[0][0].data.bookingId).toBe('b1')
  })

  it('issues no ticket when the outcome is failed', async () => {
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          status: 'PENDING',
          booking: { id: 'b1', status: 'PENDING_PAYMENT' },
        }),
        update: vi.fn(),
      },
      booking: { update: vi.fn() },
    })

    await applyPaymentOutcome({ eventId: 'evt_t3', providerRef: 'ref_1', outcome: 'failed' })

    expect(m.ticketCreate).not.toHaveBeenCalled()
  })

  // Money already owed back. A ticket here would hand out seats that
  // someone else is holding.
  it('issues no ticket for a booking already flagged REFUND_REQUIRED', async () => {
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          status: 'PENDING',
          booking: { id: 'b1', status: 'REFUND_REQUIRED' },
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      booking: { update: vi.fn(), updateMany: vi.fn() },
    })

    const result = await applyPaymentOutcome({
      eventId: 'evt_t4',
      providerRef: 'ref_1',
      outcome: 'succeeded',
    })

    expect(result.bookingStatus).toBe('REFUND_REQUIRED')
    expect(m.ticketCreate).not.toHaveBeenCalled()
  })

  it('issues no ticket when a seat was taken and a refund becomes owed', async () => {
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          status: 'PENDING',
          booking: {
            id: 'b1',
            status: 'PENDING_PAYMENT',
            seats: [{ seatId: 's1' }, { seatId: 's2' }],
          },
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 's1', status: 'AVAILABLE' },
        { id: 's2', status: 'BOOKED' },
      ]),
      seat: { updateMany: vi.fn() },
      booking: { update: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    })

    const result = await applyPaymentOutcome({
      eventId: 'evt_t5',
      providerRef: 'ref_1',
      outcome: 'succeeded',
    })

    expect(result.bookingStatus).toBe('REFUND_REQUIRED')
    expect(m.ticketCreate).not.toHaveBeenCalled()
  })

  it('issues no ticket when the event is a duplicate delivery', async () => {
    txRuns({
      webhookEvent: {
        create: vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' })),
      },
      booking: { update: vi.fn() },
    })

    const result = await applyPaymentOutcome({
      eventId: 'evt_t6',
      providerRef: 'ref_1',
      outcome: 'succeeded',
    })

    expect(result.applied).toBe(false)
    expect(m.ticketCreate).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 7: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/payment.test.ts`
Expected: FAIL — the two issuance cases report `ticketCreate` called 0 times. The four negative cases pass already; that is fine, they are regression guards.

- [ ] **Step 8: Wire `issueTicket` into both PAID paths in `apps/api/src/lib/payment.ts`**

Add the import at the top:

```ts
import { issueTicket } from './ticket.js'
```

There are exactly **two** places where the booking becomes `PAID`. Both call the same function — do not duplicate the create logic.

First, the normal compare-and-swap:

```ts
      const won = await tx.booking.updateMany({
        where: { id: payment.bookingId, status: 'PENDING_PAYMENT' },
        data: { status: 'PAID' },
      })
      if (won.count === 1) {
        // Same transaction as the status change: PAID without a ticket is a
        // state no reader should ever be able to observe.
        await issueTicket(tx, payment.bookingId)
        return { applied: true, bookingStatus: 'PAID', bookingId: payment.bookingId }
      }
```

Second, the recover path where the hold lapsed but the seats are still free:

```ts
    if (allFree) {
      await tx.seat.updateMany({ where: { id: seatIds }, data: { status: 'BOOKED' } })
      await tx.booking.update({ where: { id: payment.bookingId }, data: { status: 'PAID' } })
      await issueTicket(tx, payment.bookingId)
      return { applied: true, bookingStatus: 'PAID', bookingId: payment.bookingId }
    }
```

**Careful:** keep the existing `where: { id: { in: seatIds } }` on that `updateMany` exactly as it is — the snippet above abbreviates it. Change only the added `issueTicket` line and the added `bookingId` field.

There is a third early return, `if (payment.booking.status === 'PAID') return { applied: true, bookingStatus: 'PAID' }`. That is a re-delivery of an already-applied success — add `bookingId: payment.bookingId` to it so the caller can still identify the booking, but **do not** call `issueTicket` there: the ticket was issued when the booking first became PAID, and re-sending the confirmation email on every duplicate delivery is exactly what Task 4 avoids.

Finally update the declared return type:

```ts
): Promise<{ applied: boolean; bookingStatus?: string; bookingId?: string }> {
```

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: PASS — 120 unit tests.

- [ ] **Step 10: Prove the transaction boundary holds**

Temporarily change `await issueTicket(tx, payment.bookingId)` to use the top-level `prisma` client instead of `tx`. The unit tests will still pass — that is the point. Note in your task summary that **unit tests cannot see this class of bug**, and that the integration check in Task 7 is what covers it. Restore `tx` before committing.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/lib/ticket.ts apps/api/src/lib/payment.ts tests/unit/api/ticket-issue.test.ts tests/unit/api/payment.test.ts
git commit -m "feat(api): issue a ticket in the same transaction as PAID"
```

---

### Task 4: Confirmation email, fire-and-forget

**Files:**
- Create: `apps/api/src/lib/email.ts`
- Modify: `apps/api/src/routes/webhooks.ts`
- Test: `tests/unit/api/email.test.ts`
- Test: `tests/unit/api/webhook-route.test.ts` (extend)

**Interfaces:**
- Consumes: `RESEND_API_KEY`, `EMAIL_FROM`, `FRONTEND_ORIGIN` from config; `applyPaymentOutcome`'s `bookingId` from Task 3.
- Produces: `sendBookingConfirmation(input: { to: string; bookingId: string; eventTitle: string; startTime: Date; seats: string[]; ticketUrl: string }): Promise<void>` and `notifyBookingPaid(bookingId: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api/email.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const m = vi.hoisted(() => ({ bookingFindUnique: vi.fn() }))

vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: { booking: { findUnique: m.bookingFindUnique } },
}))

const ORIGINAL_KEY = process.env.RESEND_API_KEY

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY
  else process.env.RESEND_API_KEY = ORIGINAL_KEY
  vi.unstubAllGlobals()
})

const INPUT = {
  to: 'buyer@example.com',
  bookingId: 'b1',
  eventTitle: 'คอนเสิร์ตทดสอบ',
  startTime: new Date('2026-09-01T12:00:00Z'),
  seats: ['A1', 'A2'],
  ticketUrl: 'http://localhost:3000/me/tickets/t1',
}

describe('sendBookingConfirmation', () => {
  it('posts to Resend when an API key is configured', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' })
    vi.stubGlobal('fetch', fetchMock)

    const { sendBookingConfirmation } = await import('../../../apps/api/src/lib/email')
    await sendBookingConfirmation(INPUT)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers.Authorization).toBe('Bearer test-key')
    const body = JSON.parse(init.body)
    expect(body.to).toEqual(['buyer@example.com'])
    expect(body.html).toContain('http://localhost:3000/me/tickets/t1')
    expect(body.html).toContain('A1')
  })

  it('logs instead of sending when no API key is configured', async () => {
    delete process.env.RESEND_API_KEY
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    const { sendBookingConfirmation } = await import('../../../apps/api/src/lib/email')
    await sendBookingConfirmation(INPUT)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalled()
    info.mockRestore()
  })

  it('throws when Resend rejects the request, so the caller can log it', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => 'bad domain' }),
    )

    const { sendBookingConfirmation } = await import('../../../apps/api/src/lib/email')
    await expect(sendBookingConfirmation(INPUT)).rejects.toThrow(/422/)
  })
})

describe('notifyBookingPaid', () => {
  it('does nothing when the booking has no ticket yet', async () => {
    m.bookingFindUnique.mockResolvedValue(null)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { notifyBookingPaid } = await import('../../../apps/api/src/lib/email')
    await notifyBookingPaid('b1')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends to the booking owner with the ticket link', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    m.bookingFindUnique.mockResolvedValue({
      id: 'b1',
      user: { email: 'buyer@example.com' },
      ticket: { id: 't1' },
      showtime: { startTime: new Date('2026-09-01T12:00:00Z'), event: { title: 'คอนเสิร์ตทดสอบ' } },
      seats: [{ seat: { row: 'A', number: 1 } }],
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' })
    vi.stubGlobal('fetch', fetchMock)

    const { notifyBookingPaid } = await import('../../../apps/api/src/lib/email')
    await notifyBookingPaid('b1')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.to).toEqual(['buyer@example.com'])
    expect(body.html).toContain('/me/tickets/t1')
    expect(body.html).toContain('A1')
  })
})
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/email.test.ts`
Expected: FAIL — cannot resolve `lib/email`.

- [ ] **Step 3: Create `apps/api/src/lib/email.ts`**

Note `RESEND_API_KEY` is read from `process.env` inside the function, not imported from config — the test swaps the variable between cases and config is evaluated once at import. `EMAIL_FROM` and `FRONTEND_ORIGIN` come from config as usual.

```ts
import { prisma } from './prisma.js'
import { EMAIL_FROM, FRONTEND_ORIGIN } from './config.js'

type ConfirmationInput = {
  to: string
  bookingId: string
  eventTitle: string
  startTime: Date
  seats: string[]
  ticketUrl: string
}

// Resend's REST API directly over fetch. Their SDK wraps exactly this one
// POST — a dependency for ten lines is not worth the supply chain.
export async function sendBookingConfirmation(input: ConfirmationInput): Promise<void> {
  const when = input.startTime.toLocaleString('th-TH', { dateStyle: 'full', timeStyle: 'short' })
  const html =
    `<p>ยืนยันการจองเรียบร้อยแล้ว</p>` +
    `<p><strong>${input.eventTitle}</strong><br>${when}</p>` +
    `<p>ที่นั่ง: ${input.seats.join(', ')}</p>` +
    `<p>รหัสการจอง: ${input.bookingId}</p>` +
    `<p><a href="${input.ticketUrl}">เปิดตั๋วและ QR code</a></p>`

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    // Supported state, not a failure: local dev and CI have no mail account.
    // LIMITATION: this means "email works" is unverified until a real key is
    // configured in staging — say so rather than implying it was tested.
    console.info(`[email] would send booking confirmation to ${input.to}: ${input.ticketUrl}`)
    return
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [input.to],
      subject: `ยืนยันการจอง — ${input.eventTitle}`,
      html,
    }),
  })
  if (!res.ok) {
    throw new Error(`Resend rejected the message: ${res.status} ${await res.text()}`)
  }
}

// Loads what the confirmation needs and sends it. Separate from the pure
// function above so the route stays a thin adapter and the HTTP shape stays
// testable without a database.
export async function notifyBookingPaid(bookingId: string): Promise<void> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      user: { select: { email: true } },
      ticket: { select: { id: true } },
      showtime: { include: { event: { select: { title: true } } } },
      seats: { include: { seat: { select: { row: true, number: true } } } },
    },
  })
  // No ticket means this booking never actually became PAID — nothing to
  // confirm.
  if (!booking || !booking.ticket) return

  await sendBookingConfirmation({
    to: booking.user.email,
    bookingId: booking.id,
    eventTitle: booking.showtime.event.title,
    startTime: booking.showtime.startTime,
    seats: booking.seats.map((s) => `${s.seat.row}${s.seat.number}`),
    ticketUrl: `${FRONTEND_ORIGIN}/me/tickets/${booking.ticket.id}`,
  })
}
```

- [ ] **Step 4: Run the tests, expect pass**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/email.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing webhook-route test**

Append to `tests/unit/api/webhook-route.test.ts`. It already has `makeReq`, `makeRes`, and a signed `raw` buffer — reuse them, do not add a second set.

Add `notify: vi.fn()` to the file's existing `vi.hoisted` object `m`, and this mock alongside the existing `vi.mock` for the payment module:

```ts
vi.mock('../../../apps/api/src/lib/email', () => ({ notifyBookingPaid: m.notify }))
```

Then the tests:

```ts
describe('paymentWebhookHandler — confirmation email', () => {
  it('sends the confirmation after a successful payment', async () => {
    m.apply.mockResolvedValue({ applied: true, bookingStatus: 'PAID', bookingId: 'b1' })
    m.notify.mockResolvedValue(undefined)
    const res = makeRes()

    await paymentWebhookHandler(makeReq(raw, signWebhookPayload(raw)), res, vi.fn())

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ received: true }))
    expect(m.notify).toHaveBeenCalledWith('b1')
  })

  // `applied: false` is what a duplicate delivery returns. This is the only
  // thing stopping a retrying provider from mailing the buyer ten times.
  it('does not send on a duplicate delivery', async () => {
    m.apply.mockResolvedValue({ applied: false })
    const res = makeRes()

    await paymentWebhookHandler(makeReq(raw, signWebhookPayload(raw)), res, vi.fn())

    expect(m.notify).not.toHaveBeenCalled()
  })

  it('does not send when a refund is owed instead of a ticket', async () => {
    m.apply.mockResolvedValue({ applied: true, bookingStatus: 'REFUND_REQUIRED', bookingId: 'b1' })
    const res = makeRes()

    await paymentWebhookHandler(makeReq(raw, signWebhookPayload(raw)), res, vi.fn())

    expect(m.notify).not.toHaveBeenCalled()
  })

  // The whole reason the call is fire-and-forget: a dead mail provider must
  // not turn a completed payment into a 500 the provider then retries.
  it('still returns success when the email fails', async () => {
    m.apply.mockResolvedValue({ applied: true, bookingStatus: 'PAID', bookingId: 'b1' })
    m.notify.mockRejectedValue(new Error('smtp down'))
    const res = makeRes()

    await paymentWebhookHandler(makeReq(raw, signWebhookPayload(raw)), res, vi.fn())
    // Let the rejected promise settle so an unhandled rejection would surface.
    await new Promise((resolve) => setImmediate(resolve))

    expect(res.status).not.toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ received: true }))
  })
})
```

Note the file's `beforeEach` sets `m.apply.mockResolvedValue({ applied: true })`. Since `bookingStatus` is absent there, the existing tests will not trigger the email — that is correct and needs no change.

- [ ] **Step 6: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/webhook-route.test.ts`
Expected: FAIL — `notifyBookingPaid` never called.

- [ ] **Step 7: Wire it into `apps/api/src/routes/webhooks.ts`**

Add the import:

```ts
import { notifyBookingPaid } from '../lib/email.js'
```

and replace the success return in `paymentWebhookHandler`:

```ts
    const result = await applyPaymentOutcome(parsed.data)

    // After the transaction has committed, never inside it: an HTTP call to
    // a mail provider must not hold a seat-row lock open. Fire-and-forget
    // because the ticket is already in the database and visible at
    // /me/tickets — a mail outage must not turn a completed payment into a
    // 500 that the provider then retries forever.
    //
    // `applied` is false on a duplicate delivery, which is what keeps the
    // confirmation from being sent twice.
    if (result.applied && result.bookingStatus === 'PAID' && result.bookingId) {
      void notifyBookingPaid(result.bookingId).catch((err) =>
        logServerError('confirmation email failed', err),
      )
    }

    // 200 even when the event was a duplicate: a provider retries on any
    // non-2xx, and re-delivering something already handled helps nobody.
    return res.json({ received: true, applied: result.applied })
```

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS — 129 unit tests.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/lib/email.ts apps/api/src/routes/webhooks.ts tests/unit/api/email.test.ts tests/unit/api/webhook-route.test.ts
git commit -m "feat(api): send booking confirmation email after payment commits"
```

---

### Task 5: Ticket read endpoints

**Files:**
- Create: `apps/api/src/routes/tickets.ts`
- Modify: `apps/api/src/lib/ticket.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/package.json` (dependency)
- Test: `tests/unit/api/ticket-routes.test.ts`

**Interfaces:**
- Consumes: `requireAuth` from `apps/api/src/middleware/auth.js`, `logServerError` from `lib/log.js`.
- Produces: `listTicketsForUser(userId: string)` and `getTicketForUser(ticketId: string, userId: string)` in `lib/ticket.ts`; routers `default` (mounted at `/tickets`) and `meTicketsRouter` (mounted at `/me`).

- [ ] **Step 1: Install `qrcode`**

```bash
npm i -w apps/api qrcode && npm i -D -w apps/api @types/qrcode
```

This is the only dependency this phase adds. It is in `CLAUDE.md` §2's approved stack. **If you find yourself wanting any other package, stop and ask the user.**

- [ ] **Step 2: Write the failing route test**

Create `tests/unit/api/ticket-routes.test.ts`. Follow the request/response faking pattern already used in `tests/unit/api/auth-routes.test.ts` — read it first and reuse its helpers rather than writing new ones.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  ticketFindMany: vi.fn(),
  ticketFindFirst: vi.fn(),
}))

vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: { ticket: { findMany: m.ticketFindMany, findFirst: m.ticketFindFirst } },
}))

import { listMyTicketsHandler, getTicketHandler } from '../../../apps/api/src/routes/tickets'

beforeEach(() => vi.clearAllMocks())

function fakeRes() {
  const res: Record<string, unknown> = { statusCode: 200 }
  res.status = (code: number) => {
    res.statusCode = code
    return res
  }
  res.json = (body: unknown) => {
    res.body = body
    return res
  }
  return res as { statusCode: number; body?: unknown; status: unknown; json: unknown }
}

describe('GET /me/tickets', () => {
  it('returns 401 without a session', async () => {
    const res = fakeRes()
    await listMyTicketsHandler({ user: undefined } as never, res as never, vi.fn())
    expect(res.statusCode).toBe(401)
    expect(m.ticketFindMany).not.toHaveBeenCalled()
  })

  it('scopes the query to the caller, not to a client-supplied id', async () => {
    m.ticketFindMany.mockResolvedValue([])
    const res = fakeRes()
    await listMyTicketsHandler(
      { user: { id: 'u1' }, query: { userId: 'someone-else' } } as never,
      res as never,
      vi.fn(),
    )
    expect(m.ticketFindMany.mock.calls[0][0].where).toEqual({ booking: { userId: 'u1' } })
  })
})

describe('GET /tickets/:id', () => {
  it('returns 401 without a session', async () => {
    const res = fakeRes()
    await getTicketHandler({ params: { id: 't1' }, user: undefined } as never, res as never, vi.fn())
    expect(res.statusCode).toBe(401)
  })

  // 404 not 403: a 403 would confirm the id exists and let a caller
  // enumerate other people's tickets.
  it("returns 404 for someone else's ticket", async () => {
    m.ticketFindFirst.mockResolvedValue(null)
    const res = fakeRes()
    await getTicketHandler(
      { params: { id: 't1' }, user: { id: 'u1' } } as never,
      res as never,
      vi.fn(),
    )
    expect(res.statusCode).toBe(404)
  })

  it('scopes the lookup by owner inside the query', async () => {
    m.ticketFindFirst.mockResolvedValue(null)
    const res = fakeRes()
    await getTicketHandler(
      { params: { id: 't1' }, user: { id: 'u1' } } as never,
      res as never,
      vi.fn(),
    )
    expect(m.ticketFindFirst.mock.calls[0][0].where).toEqual({
      id: 't1',
      booking: { userId: 'u1' },
    })
  })

  it('returns the ticket with a QR data URL', async () => {
    m.ticketFindFirst.mockResolvedValue({
      id: 't1',
      qrCodePayload: 't1.abc',
      issuedAt: new Date('2026-08-12T00:00:00Z'),
      booking: {
        id: 'b1',
        showtime: {
          startTime: new Date('2026-09-01T12:00:00Z'),
          event: { title: 'คอนเสิร์ตทดสอบ', venue: { name: 'หอประชุม' } },
        },
        seats: [{ seat: { row: 'A', number: 1, seatMap: { zoneName: 'โซน A' } } }],
      },
    })
    const res = fakeRes()
    await getTicketHandler(
      { params: { id: 't1' }, user: { id: 'u1' } } as never,
      res as never,
      vi.fn(),
    )
    expect(res.statusCode).toBe(200)
    const body = res.body as { ticket: { qrDataUrl: string } }
    expect(body.ticket.qrDataUrl).toMatch(/^data:image\/png;base64,/)
  })
})
```

- [ ] **Step 3: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/ticket-routes.test.ts`
Expected: FAIL — cannot resolve `routes/tickets`.

- [ ] **Step 4: Append the queries to `apps/api/src/lib/ticket.ts`**

Add `import { prisma } from './prisma.js'` to the top, then:

```ts
// Ownership is expressed inside the query, not checked after the fact —
// a fetch-then-compare is one forgotten `if` away from leaking a stranger's
// ticket, and the route then has nothing to get wrong.
export async function listTicketsForUser(userId: string) {
  return await prisma.ticket.findMany({
    where: { booking: { userId } },
    orderBy: { issuedAt: 'desc' },
    include: {
      booking: {
        include: {
          showtime: { include: { event: { include: { venue: true } } } },
          seats: { include: { seat: { include: { seatMap: true } } } },
        },
      },
    },
  })
}

export async function getTicketForUser(ticketId: string, userId: string) {
  return await prisma.ticket.findFirst({
    where: { id: ticketId, booking: { userId } },
    include: {
      booking: {
        include: {
          showtime: { include: { event: { include: { venue: true } } } },
          seats: { include: { seat: { include: { seatMap: true } } } },
        },
      },
    },
  })
}
```

- [ ] **Step 5: Create `apps/api/src/routes/tickets.ts`**

```ts
import { Router, type RequestHandler } from 'express'
import QRCode from 'qrcode'
import { listTicketsForUser, getTicketForUser } from '../lib/ticket.js'
import { requireAuth } from '../middleware/auth.js'
import { logServerError } from '../lib/log.js'

export const listMyTicketsHandler: RequestHandler = async (req, res) => {
  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const tickets = await listTicketsForUser(userId)
    // The list deliberately omits qrCodePayload — a QR only needs rendering
    // on the page that shows one ticket, and not shipping the signed value
    // in a list response keeps it out of more logs and caches than needed.
    return res.json({ tickets })
  } catch (err) {
    logServerError('GET /me/tickets failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

export const getTicketHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' })

  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const ticket = await getTicketForUser(id, userId)
    // 404 rather than 403 for someone else's ticket: a 403 would confirm
    // the id exists, letting a caller enumerate tickets.
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' })

    // Rendered here so the browser never has to know what the payload means.
    const qrDataUrl = await QRCode.toDataURL(ticket.qrCodePayload, { margin: 1, width: 320 })
    return res.json({ ticket: { ...ticket, qrDataUrl } })
  } catch (err) {
    logServerError('GET /tickets/:id failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

const router = Router()
router.get('/:id', requireAuth, getTicketHandler)

// Mounted at /me, so this is GET /me/tickets. Same file as the handler it
// shares a query layer with — splitting it into a second route file to
// satisfy the URL prefix would spread one concern across two places.
export const meTicketsRouter = Router()
meTicketsRouter.get('/tickets', requireAuth, listMyTicketsHandler)

export default router
```

- [ ] **Step 6: Mount both routers in `apps/api/src/index.ts`**

```ts
import ticketsRouter, { meTicketsRouter } from './routes/tickets.js'
```

and alongside the other `app.use` calls, before the mock-provider block:

```ts
app.use('/tickets', ticketsRouter)
app.use('/me', meTicketsRouter)
```

- [ ] **Step 7: Run the tests, expect pass**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/ticket-routes.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 8: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS — 135 unit tests, no type errors.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/tickets.ts apps/api/src/lib/ticket.ts apps/api/src/index.ts apps/api/package.json package-lock.json tests/unit/api/ticket-routes.test.ts
git commit -m "feat(api): add /me/tickets and /tickets/:id endpoints"
```

---

### Task 6: Ticket pages

**Files:**
- Create: `apps/web/app/me/tickets/page.tsx`
- Create: `apps/web/app/me/tickets/[id]/page.tsx`
- Modify: `apps/web/app/bookings/[id]/page.tsx`

**Interfaces:**
- Consumes: `apiFetch` from `@/lib/api`; `GET /me/tickets` and `GET /tickets/:id` from Task 5.
- Produces: nothing other code imports.

Match the existing style of `apps/web/app/bookings/[id]/page.tsx` exactly: `'use client'`, `useEffect` with a `cancelled` flag, `try/catch` around `apiFetch` with a Thai connection-error message, `router.push('/login')` on `401`. All copy is Thai. No business logic — fetch and render only.

- [ ] **Step 1: Create `apps/web/app/me/tickets/page.tsx`**

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiFetch } from '@/lib/api'

type TicketListItem = {
  id: string
  issuedAt: string
  booking: {
    id: string
    showtime: { startTime: string; event: { title: string; venue: { name: string } } }
    seats: { seat: { row: string; number: number } }[]
  }
}

export default function MyTicketsPage() {
  const router = useRouter()
  const [tickets, setTickets] = useState<TicketListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let res: Response
      try {
        res = await apiFetch('/me/tickets')
      } catch (err) {
        console.error(err)
        if (!cancelled) setError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
        return
      }
      if (cancelled) return
      if (res.status === 401) {
        router.push('/login')
        return
      }
      if (!res.ok) {
        setError('โหลดตั๋วไม่สำเร็จ')
        return
      }
      const data = await res.json()
      setTickets(data.tickets)
    })()
    return () => {
      cancelled = true
    }
  }, [router])

  if (error) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <p className="text-red-600">{error}</p>
      </main>
    )
  }
  if (tickets === null) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <p>กำลังโหลด…</p>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-2xl p-8 flex flex-col gap-4">
      <h1 className="text-2xl font-bold">ตั๋วของฉัน</h1>

      {tickets.length === 0 ? (
        <p>
          ยังไม่มีตั๋ว{' '}
          <Link href="/events" className="underline">
            ดูรอบการแสดงทั้งหมด
          </Link>
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {tickets.map((t) => (
            <li key={t.id} className="border rounded p-4">
              <Link href={`/me/tickets/${t.id}`} className="flex flex-col gap-1">
                <span className="font-semibold">{t.booking.showtime.event.title}</span>
                <span className="text-sm">
                  {new Date(t.booking.showtime.startTime).toLocaleString('th-TH', {
                    dateStyle: 'full',
                    timeStyle: 'short',
                  })}
                </span>
                <span className="text-sm">{t.booking.showtime.event.venue.name}</span>
                <span className="text-sm">
                  ที่นั่ง: {t.booking.seats.map((s) => `${s.seat.row}${s.seat.number}`).join(', ')}
                </span>
                <span className="text-sm underline">เปิดตั๋ว</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
```

- [ ] **Step 2: Create `apps/web/app/me/tickets/[id]/page.tsx`**

```tsx
'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiFetch } from '@/lib/api'

type Ticket = {
  id: string
  issuedAt: string
  qrDataUrl: string
  booking: {
    id: string
    showtime: { startTime: string; event: { title: string; venue: { name: string } } }
    seats: { seat: { row: string; number: number; seatMap: { zoneName: string } } }[]
  }
}

export default function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let res: Response
      try {
        res = await apiFetch(`/tickets/${id}`)
      } catch (err) {
        console.error(err)
        if (!cancelled) setError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
        return
      }
      if (cancelled) return
      if (res.status === 401) {
        router.push('/login')
        return
      }
      if (!res.ok) {
        setError('ไม่พบตั๋วนี้')
        return
      }
      const data = await res.json()
      setTicket(data.ticket)
    })()
    return () => {
      cancelled = true
    }
  }, [id, router])

  if (error) {
    return (
      <main className="mx-auto max-w-sm p-8">
        <p className="text-red-600">{error}</p>
      </main>
    )
  }
  if (!ticket) {
    return (
      <main className="mx-auto max-w-sm p-8">
        <p>กำลังโหลด…</p>
      </main>
    )
  }

  const seats = ticket.booking.seats
    .map((s) => `${s.seat.seatMap.zoneName} ${s.seat.row}${s.seat.number}`)
    .join(', ')

  return (
    <main className="mx-auto max-w-sm p-8 flex flex-col gap-4">
      <h1 className="text-2xl font-bold">{ticket.booking.showtime.event.title}</h1>

      {/* alt carries the ticket code as text: the QR must not be the only
          way to identify this ticket for someone using a screen reader. */}
      <img
        src={ticket.qrDataUrl}
        alt={`QR code สำหรับตั๋วรหัส ${ticket.id}`}
        className="w-full max-w-[320px] self-center border rounded"
      />

      <dl className="flex flex-col gap-2 text-sm">
        <div>
          <dt className="font-semibold">รอบการแสดง</dt>
          <dd>
            {new Date(ticket.booking.showtime.startTime).toLocaleString('th-TH', {
              dateStyle: 'full',
              timeStyle: 'short',
            })}
          </dd>
        </div>
        <div>
          <dt className="font-semibold">สถานที่</dt>
          <dd>{ticket.booking.showtime.event.venue.name}</dd>
        </div>
        <div>
          <dt className="font-semibold">ที่นั่ง</dt>
          <dd>{seats}</dd>
        </div>
        <div>
          <dt className="font-semibold">รหัสตั๋ว</dt>
          <dd className="break-all font-mono">{ticket.id}</dd>
        </div>
      </dl>

      <Link href="/me/tickets" className="underline text-sm">
        ← กลับไปหน้าตั๋วของฉัน
      </Link>
    </main>
  )
}
```

- [ ] **Step 3: Link to the ticket from the booking page**

In `apps/web/app/bookings/[id]/page.tsx`, find where the page renders a `PENDING_PAYMENT` booking's pay button. Add, in the same render, a branch for a paid booking:

```tsx
      {booking.status === 'PAID' && (
        <Link href="/me/tickets" className="bg-black text-white p-2 rounded text-center">
          ดูตั๋วของฉัน
        </Link>
      )}
```

Add `import Link from 'next/link'` at the top if it is not already there. Do not restructure the rest of the page.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS, no type errors in either workspace.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/me apps/web/app/bookings
git commit -m "feat(web): add my-tickets pages and a link from the booking page"
```

---

### Task 7: Integration proof and manual check

**Files:**
- Create: `tests/integration/ticket-issuance.test.ts`

**Interfaces:**
- Consumes: `tests/integration/helpers.ts` — read it first and use its fixture create/cleanup helpers. **Never call `deleteMany()` without a `where` scoped to rows this test created:** the local Postgres is shared with every other worktree.

This is where the real transaction boundary gets proven. The unit tests in Task 3 pass whether `issueTicket` uses `tx` or the global client — only a real database can tell the difference.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/ticket-issuance.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { prisma } from '../../apps/api/src/lib/prisma'
import { applyPaymentOutcome } from '../../apps/api/src/lib/payment'
import { verifyTicketPayload } from '../../apps/api/src/lib/ticket'
import { createFixture, deleteFixture, type TestFixture } from './helpers'

let fixture: TestFixture

beforeEach(async () => {
  fixture = await createFixture({ withBooking: true, withPendingPayment: true })
})

afterEach(async () => {
  // Ticket rows must go before deleteFixture removes the booking they
  // reference, and both are scoped to ids this test created — the local
  // Postgres is shared with every other worktree.
  await prisma.ticket.deleteMany({ where: { bookingId: fixture.bookingId } })
  await prisma.webhookEvent.deleteMany({ where: { eventId: { startsWith: 'evt_tkt_' } } })
  await deleteFixture(fixture)
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('ticket issuance', () => {
  it('issues exactly one ticket, in the same transaction as PAID', async () => {
    const result = await applyPaymentOutcome({
      eventId: `evt_tkt_${Date.now()}_seq`,
      providerRef: fixture.providerRef,
      outcome: 'succeeded',
    })

    expect(result.bookingStatus).toBe('PAID')

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: fixture.bookingId } })
    expect(booking.status).toBe('PAID')

    const tickets = await prisma.ticket.findMany({ where: { bookingId: fixture.bookingId } })
    expect(tickets).toHaveLength(1)
    // The signature must cover the id actually written to the row. A unit
    // test can only check what was passed to a mock; this checks the row.
    expect(verifyTicketPayload(tickets[0].qrCodePayload)).toBe(tickets[0].id)
  })

  // The one that matters, and the one unit tests cannot see. Two DIFFERENT
  // eventIds mean the WebhookEvent guard does NOT short-circuit the second
  // delivery — so the Ticket.bookingId unique constraint is the only thing
  // left holding. Drop that index and this test must go red.
  it('issues one ticket when two distinct successes land at once', async () => {
    const stamp = Date.now()
    const results = await Promise.allSettled([
      applyPaymentOutcome({
        eventId: `evt_tkt_${stamp}_a`,
        providerRef: fixture.providerRef,
        outcome: 'succeeded',
      }),
      applyPaymentOutcome({
        eventId: `evt_tkt_${stamp}_b`,
        providerRef: fixture.providerRef,
        outcome: 'succeeded',
      }),
    ])

    // Neither call may blow up — a P2002 escaping issueTicket would surface
    // to the provider as a 500 and trigger an endless retry.
    for (const r of results) expect(r.status).toBe('fulfilled')

    const tickets = await prisma.ticket.findMany({ where: { bookingId: fixture.bookingId } })
    expect(tickets).toHaveLength(1)
  })

  it('issues no ticket when the payment fails', async () => {
    await applyPaymentOutcome({
      eventId: `evt_tkt_${Date.now()}_fail`,
      providerRef: fixture.providerRef,
      outcome: 'failed',
    })

    expect(await prisma.ticket.count({ where: { bookingId: fixture.bookingId } })).toBe(0)
  })
})
```

- [ ] **Step 2: Run it**

Run: `cd apps/api && npm run test:integration`
Expected: PASS, 7 tests (4 existing + 3 new). Docker must be running — check `docker info` first. **Never stop or restart the shared Postgres/Redis containers.**

- [ ] **Step 3: Prove the constraint is what protects it**

The honest way to show the unique constraint carries the weight is to drop it and watch the test fail. **The permission classifier blocks raw DDL from this session** (a previous phase hit exactly this). Do not route around it. Instead, print the command and ask the user to run it themselves with the `!` prefix:

```
! docker exec ticket-booking-system-postgres-1 psql -U postgres -d ticket_booking -c 'DROP INDEX "Ticket_bookingId_key"'
```

If the user declines or skips it, say plainly in the summary that the mutation check was not performed — do not imply it was.

- [ ] **Step 4: Manual check**

With `npm run dev:api` and `npm run dev:web` running:

1. Book a seat, pay via the mock page, land back on `/bookings/[id]`.
2. Click "ดูตั๋วของฉัน" → the ticket appears at `/me/tickets`.
3. Open the ticket → scan the QR with a phone camera. It must decode to `<ticketId>.<64 hex chars>`, and that `ticketId` must match the "รหัสตั๋ว" shown on the page.
4. Log in as a different user and open the first user's ticket URL directly → must be `404` / "ไม่พบตั๋วนี้".
5. Confirm the API log shows the `[email] would send booking confirmation to …` line (no `RESEND_API_KEY` configured).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/ticket-issuance.test.ts
git commit -m "test(api): prove ticket issuance is transactional and idempotent"
```

---

## Definition of Done

Per `CLAUDE.md` §6, this phase is done only when all of these hold:

1. `npm run build` clean in both workspaces, no type errors.
2. `npm test` green — 135 unit tests — plus `cd apps/api && npm run test:integration` green, 7 tests.
3. The Task 7 manual checklist walked at least once.
4. A summary stating what was built, what was deliberately skipped, and what a human must review.

**Report honestly, do not round up.** Two Phase 4 checklist items from the plan document cannot be closed here, and the summary must say so rather than implying they passed:

- **"อีเมลส่งถึงจริงในสภาพแวดล้อม staging"** — unverifiable without a `RESEND_API_KEY`. What was verified is the log-only path and the request shape, not delivery.
- **Playwright e2e** — deferred since Phase 2, and deliberately still deferred. The full search → book → pay → ticket path is only now complete; running it belongs in its own session.

## Deliberately out of scope

| Skipped | Add when |
|---|---|
| `POST /tickets/verify` scanning endpoint | A real scanner app exists — and design "already used?" at the same time, since the payload alone cannot answer it |
| PDF / Apple Wallet tickets | Someone asks |
| Resend-email retry queue | Email becomes the primary delivery channel — needs a new dependency, so **ask the user first** |
| Refund of `REFUND_REQUIRED` bookings | Never, by decision of 12 Aug 2026. Phase 5's admin booking list surfaces the status; a human refunds in the provider's own dashboard |
