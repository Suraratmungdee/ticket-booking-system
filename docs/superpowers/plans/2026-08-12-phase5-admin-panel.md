# Phase 5 — Admin Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an administrator a guarded surface to create venues, events, showtimes and seat maps, to browse every booking, and to see sales and remaining seats per showtime — with every mutation recorded in an audit log written in the same transaction as the change it describes.

**Architecture:** One `requireAdmin` middleware that reads the caller's role **from the database, not from the JWT**, so revoking admin takes effect immediately instead of when a 2-hour token expires. All admin business logic lives in `apps/api/src/lib/admin.ts`; the route file is a thin adapter. Every mutating handler wraps its write and its `recordAudit` call in one `prisma.$transaction`. There are no DELETE endpoints and nothing mutates `Showtime.status`.

**Spec:** `docs/superpowers/specs/2026-08-12-phase5-admin-panel-design.md` — read it before starting, especially the section explaining why there is no cancel-showtime endpoint.

**Tech Stack:** Express 5 + TypeScript (ESM/NodeNext), Prisma v6, PostgreSQL, Next.js 16 App Router, Tailwind v4, Vitest, zod. **No new dependencies.**

## Global Constraints

- npm workspaces: `apps/api` owns all business logic and DB access; `apps/web` is UI only — no validation, no calculation, no state decisions in the frontend.
- `apps/api/src` is ESM/NodeNext — **every relative import needs a `.js` extension**. Files under `tests/` must NOT have them. `apps/web` uses bundler resolution — no extensions.
- All business constants live in `apps/api/src/lib/config.ts`. Never hardcode one in two places.
- Routes are thin adapters matching `apps/api/src/routes/events.ts` and `bookings.ts`: zod `safeParse` → `400` with `parsed.error.flatten()`; named exported handlers; `try/catch` → `logServerError(...)` → generic `500 { error: 'Internal server error' }`.
- **Not-authorised returns `404`, never `403`** — a 403 confirms the route exists.
- **No `DELETE` endpoints at all. Nothing may write `Showtime.status`.** Both are explicit human decisions recorded in the spec.
- Money is `Int` (whole baht). Never `Float`.
- Migrations are additive. No `DROP` without approval. The local Postgres is shared with other worktrees — a migration here changes what they all see.
- **No new dependencies.** If you want one, stop and ask.
- No secrets committed. **`.env.example` placeholders are covered by a drift test** (`tests/unit/api/config-guard.test.ts`) that reads the file from disk — read that test before adding any line to `.env.example`, and make sure your addition does not break it.
- Deliberate corner-cuts carry a `// LIMITATION:` or `// ponytail:` comment naming the ceiling and the upgrade trigger.
- Every branch needs at least one test that genuinely fails if the logic breaks.
- **Never write a comment that overstates what a test covers.** Phase 4 shipped a test comment claiming it reproduced a race it did not, and the final review caught it by reverting the fix and watching the suite stay green. If you are unsure whether a test really covers something, revert the code it guards and look.
- Current baseline: root `npm run build` clean, `npm test` = **142 unit tests**, `cd apps/api && npm run test:integration` = **7 tests**. All must keep passing.

## Lessons from Phase 4 that apply directly here

These are not general advice — each one caused a real defect two weeks ago in this codebase:

1. **Prisma `include` does not narrow columns.** It returns every scalar of the base model plus the named relations. When a response must omit a field, use `select`. Phase 4 leaked a signed QR payload this way.
2. **Never catch `P2002` (or any constraint error) and continue inside a transaction.** Postgres aborts the transaction on a constraint violation and Prisma does not savepoint per query, so the COMMIT silently becomes a ROLLBACK. Let it propagate.
3. **Never branch on a value read before you took the lock that protects it.** Read it under the lock, or put the expected value in the write's `where` and check `count`.
4. **A `deleteMany` in a test must be scoped to rows that test created.** The dev Postgres is shared across worktrees.

---

### Task 1: Schema, config constant, and the seeded admin

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/lib/config.ts`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/prisma/seed.ts`
- Test: `tests/unit/api/config-guard.test.ts`

**Interfaces:**
- Produces model `AdminAuditLog` and back-relation `User.auditLogs`.
- Produces `config.ts` export `MAX_SEATS_PER_SEATMAP: number` (value `100`).

- [ ] **Step 1: Append the model to `apps/api/prisma/schema.prisma`**

```prisma
// Who changed what, and when. Written inside the same transaction as the
// change it describes — a log that can disagree with the data is worse than
// no log, because it invites people to trust it.
model AdminAuditLog {
  id         String   @id @default(cuid())
  adminId    String
  admin      User     @relation(fields: [adminId], references: [id])
  // '<resource>.<verb>', e.g. 'event.create'. Deliberately a String, not an
  // enum: an enum would force a migration for every new action and give
  // nothing back.
  action     String
  targetType String
  targetId   String
  createdAt  DateTime @default(now())

  @@index([createdAt])
}
```

Add the back-relation to the existing `User` model, leaving every other field untouched:

```prisma
model User {
  // ...existing fields unchanged...
  auditLogs AdminAuditLog[]
}
```

- [ ] **Step 2: Append the constant to `apps/api/src/lib/config.ts`**

```ts
// Cap on seats one POST /admin/seatmaps may generate. Chosen by a human on
// 12 Aug 2026 as "enough for this project", not derived from a real hall's
// capacity — a bigger zone means several requests, or moving this number.
// The point of the cap is that one request cannot ask for a million rows.
export const MAX_SEATS_PER_SEATMAP = 100
```

- [ ] **Step 3: Add the seed variables to `apps/api/.env.example`**

**Read `tests/unit/api/config-guard.test.ts` first** — it parses this file and asserts that placeholder secrets are values the production guard rejects. Empty values are the safe shape here, matching how `RESEND_API_KEY` is already handled:

```
SEED_ADMIN_EMAIL=""
SEED_ADMIN_PASSWORD=""
```

- [ ] **Step 4: Seed an admin in `apps/api/prisma/seed.ts`**

Add this inside `main()`, after the existing seeding. Note the existing `assertSeedIsSafe()` already refuses to run outside localhost, so no new guard is needed:

```ts
  // Both must be set explicitly. A default password on an admin account is a
  // back door committed to git — skipping is the only safe fallback.
  const adminEmail = process.env.SEED_ADMIN_EMAIL
  const adminPassword = process.env.SEED_ADMIN_PASSWORD
  if (adminEmail && adminPassword) {
    const passwordHash = await bcrypt.hash(adminPassword, BCRYPT_SALT_ROUNDS)
    await prisma.user.upsert({
      where: { email: adminEmail },
      update: { role: 'ADMIN', passwordHash },
      create: { email: adminEmail, passwordHash, name: 'Admin', role: 'ADMIN' },
    })
    console.log(`Seeded admin ${adminEmail}`)
  } else {
    console.log('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set — skipped creating an admin')
  }
```

Add the imports the snippet needs at the top of `seed.ts`:

```ts
import bcrypt from 'bcrypt'
import { BCRYPT_SALT_ROUNDS } from '../src/lib/config.js'
```

Note the seed's existing `deleteMany` calls do not touch `User`, so a re-seed will not delete the admin — `upsert` keeps it current.

- [ ] **Step 5: Run the config-guard test to confirm you did not break the drift check**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/config-guard.test.ts`
Expected: PASS, unchanged count. If it fails, your `.env.example` addition broke the drift test — fix the addition, not the test.

- [ ] **Step 6: Create the migration**

```bash
cd apps/api && npx prisma migrate dev --name add_admin_audit_log
```

**Open the generated SQL and confirm it contains only `CREATE TABLE "AdminAuditLog"`, its index, and an `ALTER TABLE ... ADD CONSTRAINT` foreign key.** If it contains any `DROP`, stop and report to the user — do not apply it.

- [ ] **Step 7: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS, 142 unit tests, no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma apps/api/src/lib/config.ts apps/api/.env.example
git commit -m "feat(api): add AdminAuditLog, seat-map cap, and a seeded admin"
```

---

### Task 2: The admin guard and the audit helper

**Files:**
- Modify: `apps/api/src/middleware/auth.ts`
- Create: `apps/api/src/lib/audit.ts`
- Test: `tests/unit/api/require-admin.test.ts`
- Test: `tests/unit/api/audit.test.ts`

**Interfaces:**
- Consumes: `requireAuth` (already in `middleware/auth.ts`), which sets `req.user = { id, role }` from the JWT.
- Produces: `requireAdmin: RequestHandler` — 404s anyone who is not an `ADMIN` in the database.
- Produces: `recordAudit(tx: Prisma.TransactionClient, input: { adminId: string; action: string; targetType: string; targetId: string }): Promise<void>`.

- [ ] **Step 1: Write the failing tests for `requireAdmin`**

Create `tests/unit/api/require-admin.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ userFindUnique: vi.fn() }))

vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: { user: { findUnique: m.userFindUnique } },
}))

import { requireAdmin } from '../../../apps/api/src/middleware/auth'

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() } as any
  res.status.mockReturnValue(res)
  res.json.mockReturnValue(res)
  return res
}

beforeEach(() => vi.clearAllMocks())

describe('requireAdmin', () => {
  it('passes an admin through', async () => {
    m.userFindUnique.mockResolvedValue({ role: 'ADMIN' })
    const next = vi.fn()
    const res = makeRes()

    await requireAdmin({ user: { id: 'u1', role: 'ADMIN' } } as never, res, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  // 404 not 403: a 403 confirms the admin routes exist.
  it('404s a normal user', async () => {
    m.userFindUnique.mockResolvedValue({ role: 'USER' })
    const next = vi.fn()
    const res = makeRes()

    await requireAdmin({ user: { id: 'u1', role: 'USER' } } as never, res, next)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(next).not.toHaveBeenCalled()
  })

  // THE test for this middleware. The JWT still says ADMIN because it was
  // issued before the demotion and lives for two hours; the database says
  // USER. Reading the role from the token instead of the database would let
  // a revoked admin keep full write access for the rest of that window.
  it('blocks a demoted admin immediately, even though their token still says ADMIN', async () => {
    m.userFindUnique.mockResolvedValue({ role: 'USER' })
    const next = vi.fn()
    const res = makeRes()

    await requireAdmin({ user: { id: 'u1', role: 'ADMIN' } } as never, res, next)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(next).not.toHaveBeenCalled()
  })

  it('404s when the user row no longer exists', async () => {
    m.userFindUnique.mockResolvedValue(null)
    const next = vi.fn()
    const res = makeRes()

    await requireAdmin({ user: { id: 'deleted', role: 'ADMIN' } } as never, res, next)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(next).not.toHaveBeenCalled()
  })

  it('401s when there is no session at all', async () => {
    const next = vi.fn()
    const res = makeRes()

    await requireAdmin({ user: undefined } as never, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(m.userFindUnique).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/require-admin.test.ts`
Expected: FAIL — `requireAdmin is not a function`.

- [ ] **Step 3: Append `requireAdmin` to `apps/api/src/middleware/auth.ts`**

Add `import { prisma } from '../lib/prisma.js'` at the top, then:

```ts
// Always mounted AFTER requireAuth, which puts the caller on req.user.
//
// The role comes from the database, not from req.user.role (which came from
// the JWT). A token lives for JWT_MAX_AGE_MS — two hours — so trusting its
// role claim would let someone whose admin rights were revoked keep writing
// to every table for the rest of that window. One extra query, only on
// /admin routes, buys immediate revocation.
export const requireAdmin: RequestHandler = async (req, res, next) => {
  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  })

  // 404, not 403: a 403 would confirm to a normal user that these routes
  // exist at all. Same rule the booking and ticket routes follow.
  if (!user || user.role !== 'ADMIN') {
    return res.status(404).json({ error: 'Not found' })
  }

  return next()
}
```

- [ ] **Step 4: Run the tests, expect pass**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/require-admin.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Prove the database read earns its place**

Temporarily change the middleware to read `req.user.role` instead of querying. Re-run. The "blocks a demoted admin immediately" test must FAIL. Restore, confirm green, and record both outputs in your report. If that test stays green either way, it is not testing what it claims and must be fixed.

- [ ] **Step 6: Write the failing test for `recordAudit`**

Create `tests/unit/api/audit.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordAudit } from '../../../apps/api/src/lib/audit'

beforeEach(() => vi.clearAllMocks())

describe('recordAudit', () => {
  it('writes the entry through the transaction client it was given', async () => {
    const create = vi.fn().mockResolvedValue({})
    const tx = { adminAuditLog: { create } } as never

    await recordAudit(tx, {
      adminId: 'admin-1',
      action: 'event.create',
      targetType: 'Event',
      targetId: 'e1',
    })

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0].data).toEqual({
      adminId: 'admin-1',
      action: 'event.create',
      targetType: 'Event',
      targetId: 'e1',
    })
  })

  // If it swallowed errors, a failed log would leave the mutation committed
  // with no record of who made it — the exact thing an audit log exists to
  // prevent. Letting it throw rolls the whole transaction back.
  it('propagates a write failure instead of swallowing it', async () => {
    const create = vi.fn().mockRejectedValue(new Error('db down'))
    const tx = { adminAuditLog: { create } } as never

    await expect(
      recordAudit(tx, { adminId: 'a', action: 'event.create', targetType: 'Event', targetId: 'e' }),
    ).rejects.toThrow('db down')
  })
})
```

- [ ] **Step 7: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/audit.test.ts`
Expected: FAIL — cannot resolve `lib/audit`.

- [ ] **Step 8: Create `apps/api/src/lib/audit.ts`**

```ts
import type { Prisma } from '@prisma/client'

// Takes a transaction client, never the global prisma import: the entry has
// to commit or roll back together with the change it describes. Written the
// other way round, a crash between the two leaves either an unexplained
// change or a log of something that never happened — and a log people cannot
// trust is worse than no log, because they trust it anyway.
//
// Errors deliberately propagate. See the test.
export async function recordAudit(
  tx: Prisma.TransactionClient,
  input: { adminId: string; action: string; targetType: string; targetId: string },
): Promise<void> {
  await tx.adminAuditLog.create({ data: input })
}
```

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: PASS — 149 unit tests.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/middleware/auth.ts apps/api/src/lib/audit.ts tests/unit/api/require-admin.test.ts tests/unit/api/audit.test.ts
git commit -m "feat(api): add requireAdmin guard and transactional audit helper"
```

---

### Task 3: Venue and event endpoints

**Files:**
- Create: `apps/api/src/lib/admin.ts`
- Create: `apps/api/src/routes/admin.ts`
- Modify: `apps/api/src/index.ts`
- Test: `tests/unit/api/admin-catalog.test.ts`

**Interfaces:**
- Consumes: `requireAuth`, `requireAdmin`, `recordAudit` from Task 2.
- Produces in `lib/admin.ts`: `listVenues()`, `createVenue(adminId, input)`, `updateVenue(adminId, id, input)`, `listAllEvents()`, `createEvent(adminId, input)`, `updateEvent(adminId, id, input)`.
- Produces the router mounted at `/admin`, which Tasks 4 and 5 extend.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/api/admin-catalog.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  venueFindMany: vi.fn(),
  eventFindMany: vi.fn(),
  venueCreate: vi.fn(),
  venueUpdate: vi.fn(),
  eventCreate: vi.fn(),
  eventUpdate: vi.fn(),
  auditCreate: vi.fn(),
}))

vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: {
    $transaction: m.transaction,
    venue: { findMany: m.venueFindMany },
    event: { findMany: m.eventFindMany },
  },
}))

import {
  createVenue,
  updateVenue,
  createEvent,
  updateEvent,
} from '../../../apps/api/src/lib/admin'

// Every mutation runs inside one transaction; this stub is the client it gets.
function txRuns() {
  m.transaction.mockImplementation(async (fn: (t: unknown) => unknown) =>
    fn({
      venue: { create: m.venueCreate, update: m.venueUpdate },
      event: { create: m.eventCreate, update: m.eventUpdate },
      adminAuditLog: { create: m.auditCreate },
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  txRuns()
})

describe('createVenue', () => {
  it('creates the venue and its audit entry in one transaction', async () => {
    m.venueCreate.mockResolvedValue({ id: 'v1', name: 'หอประชุม', address: 'กรุงเทพฯ' })

    const venue = await createVenue('admin-1', { name: 'หอประชุม', address: 'กรุงเทพฯ' })

    expect(venue.id).toBe('v1')
    expect(m.transaction).toHaveBeenCalledTimes(1)
    expect(m.auditCreate).toHaveBeenCalledTimes(1)
    expect(m.auditCreate.mock.calls[0][0].data).toEqual({
      adminId: 'admin-1',
      action: 'venue.create',
      targetType: 'Venue',
      targetId: 'v1',
    })
  })

  // The audit write must be inside the transaction, so a failure takes the
  // whole thing down rather than leaving an unlogged change behind.
  it('rejects and writes nothing when the audit entry fails', async () => {
    m.venueCreate.mockResolvedValue({ id: 'v1' })
    m.auditCreate.mockRejectedValue(new Error('audit down'))

    await expect(createVenue('admin-1', { name: 'x', address: 'y' })).rejects.toThrow('audit down')
  })
})

describe('updateVenue', () => {
  it('records a venue.update entry against the venue id', async () => {
    m.venueUpdate.mockResolvedValue({ id: 'v1', name: 'ใหม่', address: 'กรุงเทพฯ' })

    await updateVenue('admin-1', 'v1', { name: 'ใหม่' })

    expect(m.venueUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'v1' }, data: { name: 'ใหม่' } }),
    )
    expect(m.auditCreate.mock.calls[0][0].data).toEqual({
      adminId: 'admin-1',
      action: 'venue.update',
      targetType: 'Venue',
      targetId: 'v1',
    })
  })
})

describe('createEvent', () => {
  it('creates the event and its audit entry in one transaction', async () => {
    m.eventCreate.mockResolvedValue({ id: 'e1', title: 'คอนเสิร์ต' })

    const event = await createEvent('admin-1', {
      title: 'คอนเสิร์ต',
      description: 'รายละเอียด',
      venueId: 'v1',
    })

    expect(event.id).toBe('e1')
    expect(m.auditCreate.mock.calls[0][0].data).toEqual({
      adminId: 'admin-1',
      action: 'event.create',
      targetType: 'Event',
      targetId: 'e1',
    })
  })
})

describe('updateEvent', () => {
  it('records an event.update entry', async () => {
    m.eventUpdate.mockResolvedValue({ id: 'e1', title: 'ใหม่' })

    await updateEvent('admin-1', 'e1', { title: 'ใหม่' })

    expect(m.auditCreate.mock.calls[0][0].data.action).toBe('event.update')
    expect(m.auditCreate.mock.calls[0][0].data.targetId).toBe('e1')
  })
})
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/admin-catalog.test.ts`
Expected: FAIL — cannot resolve `lib/admin`.

- [ ] **Step 3: Create `apps/api/src/lib/admin.ts`**

```ts
import { prisma } from './prisma.js'
import { recordAudit } from './audit.js'

// Every mutation below follows the same shape: write, then record the audit
// entry, both inside one prisma.$transaction. Neither may land without the
// other.

export async function listVenues() {
  return prisma.venue.findMany({ orderBy: { name: 'asc' } })
}

export async function createVenue(adminId: string, input: { name: string; address: string }) {
  return prisma.$transaction(async (tx) => {
    const venue = await tx.venue.create({ data: input })
    await recordAudit(tx, {
      adminId,
      action: 'venue.create',
      targetType: 'Venue',
      targetId: venue.id,
    })
    return venue
  })
}

export async function updateVenue(
  adminId: string,
  id: string,
  input: { name?: string; address?: string },
) {
  return prisma.$transaction(async (tx) => {
    const venue = await tx.venue.update({ where: { id }, data: input })
    await recordAudit(tx, {
      adminId,
      action: 'venue.update',
      targetType: 'Venue',
      targetId: id,
    })
    return venue
  })
}

// Unlike GET /events, this is not filtered — an admin needs to see
// everything, including events with no showtimes yet.
//
// LIMITATION: no pagination. Fine at this catalog size; add a cursor once
// the list outgrows one screen.
export async function listAllEvents() {
  return prisma.event.findMany({
    orderBy: { title: 'asc' },
    include: { venue: true, showtimes: { orderBy: { startTime: 'asc' } } },
  })
}

export async function createEvent(
  adminId: string,
  input: { title: string; description: string; venueId: string },
) {
  return prisma.$transaction(async (tx) => {
    const event = await tx.event.create({ data: input })
    await recordAudit(tx, {
      adminId,
      action: 'event.create',
      targetType: 'Event',
      targetId: event.id,
    })
    return event
  })
}

export async function updateEvent(
  adminId: string,
  id: string,
  input: { title?: string; description?: string; venueId?: string },
) {
  return prisma.$transaction(async (tx) => {
    const event = await tx.event.update({ where: { id }, data: input })
    await recordAudit(tx, {
      adminId,
      action: 'event.update',
      targetType: 'Event',
      targetId: id,
    })
    return event
  })
}
```

- [ ] **Step 4: Create `apps/api/src/routes/admin.ts`**

```ts
import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import {
  listVenues,
  createVenue,
  updateVenue,
  listAllEvents,
  createEvent,
  updateEvent,
} from '../lib/admin.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { logServerError } from '../lib/log.js'

const router = Router()

// Prisma throws P2025 when an update targets a row that does not exist, and
// P2003 when a foreign key (venueId, showtimeId, eventId) points at nothing.
// Both mean the caller sent a bad id, not that the server broke.
function isPrismaCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code
}

const venueCreateSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(500),
})
const venueUpdateSchema = venueCreateSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'At least one field must be provided' },
)

export const listVenuesHandler: RequestHandler = async (_req, res) => {
  try {
    return res.json({ venues: await listVenues() })
  } catch (err) {
    logServerError('GET /admin/venues failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

export const createVenueHandler: RequestHandler = async (req, res) => {
  const parsed = venueCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const adminId = req.user?.id
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    return res.status(201).json({ venue: await createVenue(adminId, parsed.data) })
  } catch (err) {
    logServerError('POST /admin/venues failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

export const updateVenueHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' })

  const parsed = venueUpdateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const adminId = req.user?.id
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    return res.json({ venue: await updateVenue(adminId, id, parsed.data) })
  } catch (err) {
    if (isPrismaCode(err, 'P2025')) return res.status(404).json({ error: 'Venue not found' })
    logServerError('PATCH /admin/venues/:id failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

const eventCreateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  venueId: z.string().min(1),
})
const eventUpdateSchema = eventCreateSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'At least one field must be provided' },
)

export const listEventsHandler: RequestHandler = async (_req, res) => {
  try {
    return res.json({ events: await listAllEvents() })
  } catch (err) {
    logServerError('GET /admin/events failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

export const createEventHandler: RequestHandler = async (req, res) => {
  const parsed = eventCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const adminId = req.user?.id
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    return res.status(201).json({ event: await createEvent(adminId, parsed.data) })
  } catch (err) {
    // A venueId that does not exist is the caller's mistake, not ours.
    if (isPrismaCode(err, 'P2003')) return res.status(400).json({ error: 'Unknown venueId' })
    logServerError('POST /admin/events failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

export const updateEventHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' })

  const parsed = eventUpdateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const adminId = req.user?.id
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    return res.json({ event: await updateEvent(adminId, id, parsed.data) })
  } catch (err) {
    if (isPrismaCode(err, 'P2025')) return res.status(404).json({ error: 'Event not found' })
    if (isPrismaCode(err, 'P2003')) return res.status(400).json({ error: 'Unknown venueId' })
    logServerError('PATCH /admin/events/:id failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// requireAuth then requireAdmin on every route, with no exceptions. A route
// added below without both is an unguarded write to the whole catalog.
router.get('/venues', requireAuth, requireAdmin, listVenuesHandler)
router.post('/venues', requireAuth, requireAdmin, createVenueHandler)
router.patch('/venues/:id', requireAuth, requireAdmin, updateVenueHandler)
router.get('/events', requireAuth, requireAdmin, listEventsHandler)
router.post('/events', requireAuth, requireAdmin, createEventHandler)
router.patch('/events/:id', requireAuth, requireAdmin, updateEventHandler)

export default router
```

- [ ] **Step 5: Mount it in `apps/api/src/index.ts`**

Add the import with the other route imports:

```ts
import adminRouter from './routes/admin.js'
```

and the mount alongside the other `app.use` calls, above the conditional mock-provider block:

```ts
app.use('/admin', adminRouter)
```

- [ ] **Step 6: Run the tests, expect pass**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/admin-catalog.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS — 154 unit tests, no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/admin.ts apps/api/src/routes/admin.ts apps/api/src/index.ts tests/unit/api/admin-catalog.test.ts
git commit -m "feat(api): add admin venue and event endpoints with audit logging"
```

---

### Task 4: Showtime and seat-map endpoints

**Files:**
- Modify: `apps/api/src/lib/admin.ts`
- Modify: `apps/api/src/routes/admin.ts`
- Test: `tests/unit/api/admin-seatmap.test.ts`

**Interfaces:**
- Consumes: `recordAudit`, `MAX_SEATS_PER_SEATMAP`, and the router from Task 3.
- Produces: `createShowtime(adminId, input)`, `updateShowtime(adminId, id, input)`, `createSeatMap(adminId, input)`, and the error class `SeatMapTooLargeError`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/api/admin-seatmap.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  showtimeCreate: vi.fn(),
  showtimeUpdate: vi.fn(),
  seatMapCreate: vi.fn(),
  auditCreate: vi.fn(),
}))

vi.mock('../../../apps/api/src/lib/prisma', () => ({ prisma: { $transaction: m.transaction } }))

import {
  createShowtime,
  createSeatMap,
  SeatMapTooLargeError,
} from '../../../apps/api/src/lib/admin'
import { MAX_SEATS_PER_SEATMAP } from '../../../apps/api/src/lib/config'

function txRuns() {
  m.transaction.mockImplementation(async (fn: (t: unknown) => unknown) =>
    fn({
      showtime: { create: m.showtimeCreate, update: m.showtimeUpdate },
      seatMap: { create: m.seatMapCreate },
      adminAuditLog: { create: m.auditCreate },
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  txRuns()
})

describe('createShowtime', () => {
  it('creates the showtime and its audit entry', async () => {
    m.showtimeCreate.mockResolvedValue({ id: 'st1' })

    await createShowtime('admin-1', {
      eventId: 'e1',
      startTime: new Date('2026-09-01T12:00:00Z'),
      endTime: new Date('2026-09-01T14:00:00Z'),
    })

    expect(m.auditCreate.mock.calls[0][0].data).toEqual({
      adminId: 'admin-1',
      action: 'showtime.create',
      targetType: 'Showtime',
      targetId: 'st1',
    })
  })

  // Nothing in this phase may write Showtime.status — createBooking checks
  // it without holding a lock on the row, so any runtime mutation opens a
  // race. See the spec.
  it('never sets status', async () => {
    m.showtimeCreate.mockResolvedValue({ id: 'st1' })

    await createShowtime('admin-1', {
      eventId: 'e1',
      startTime: new Date('2026-09-01T12:00:00Z'),
      endTime: new Date('2026-09-01T14:00:00Z'),
    })

    expect(m.showtimeCreate.mock.calls[0][0].data).not.toHaveProperty('status')
  })
})

describe('createSeatMap', () => {
  it('generates one seat per row per number, all AVAILABLE', async () => {
    m.seatMapCreate.mockResolvedValue({ id: 'sm1' })

    await createSeatMap('admin-1', {
      showtimeId: 'st1',
      zoneName: 'โซน A',
      price: 1500,
      rows: ['A', 'B'],
      seatsPerRow: 3,
    })

    const { data } = m.seatMapCreate.mock.calls[0][0]
    expect(data.seats.create).toHaveLength(6)
    expect(data.seats.create[0]).toEqual({ row: 'A', number: 1 })
    expect(data.seats.create[5]).toEqual({ row: 'B', number: 3 })
    // status is never accepted from a caller — the schema default is the
    // only thing that may set it.
    expect(data.seats.create[0]).not.toHaveProperty('status')
    expect(data.price).toBe(1500)
  })

  it('creates the seat map and its seats in one transaction with the audit entry', async () => {
    m.seatMapCreate.mockResolvedValue({ id: 'sm1' })

    await createSeatMap('admin-1', {
      showtimeId: 'st1',
      zoneName: 'โซน A',
      price: 1500,
      rows: ['A'],
      seatsPerRow: 2,
    })

    expect(m.transaction).toHaveBeenCalledTimes(1)
    expect(m.auditCreate.mock.calls[0][0].data).toEqual({
      adminId: 'admin-1',
      action: 'seatmap.create',
      targetType: 'SeatMap',
      targetId: 'sm1',
    })
  })

  it('rejects a request over the cap before touching the database', async () => {
    await expect(
      createSeatMap('admin-1', {
        showtimeId: 'st1',
        zoneName: 'ใหญ่เกิน',
        price: 100,
        rows: Array.from({ length: 20 }, (_, i) => `R${i}`),
        seatsPerRow: 20, // 400 > 100
      }),
    ).rejects.toThrow(SeatMapTooLargeError)

    expect(m.transaction).not.toHaveBeenCalled()
  })

  it('accepts a request exactly at the cap', async () => {
    m.seatMapCreate.mockResolvedValue({ id: 'sm1' })

    await createSeatMap('admin-1', {
      showtimeId: 'st1',
      zoneName: 'พอดี',
      price: 100,
      rows: ['A'],
      seatsPerRow: MAX_SEATS_PER_SEATMAP,
    })

    expect(m.seatMapCreate.mock.calls[0][0].data.seats.create).toHaveLength(MAX_SEATS_PER_SEATMAP)
  })
})
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/admin-seatmap.test.ts`
Expected: FAIL — `createShowtime is not a function`.

- [ ] **Step 3: Append to `apps/api/src/lib/admin.ts`**

Add `import { MAX_SEATS_PER_SEATMAP } from './config.js'` at the top, then:

```ts
export class SeatMapTooLargeError extends Error {}

export async function createShowtime(
  adminId: string,
  input: { eventId: string; startTime: Date; endTime: Date },
) {
  return prisma.$transaction(async (tx) => {
    // `status` is deliberately absent: the schema default (SCHEDULED) is the
    // only thing that ever sets it. Nothing in this phase may change it —
    // createBooking reads Showtime.status without locking that row, so a
    // runtime mutation would create a check-then-act race. See the spec.
    const showtime = await tx.showtime.create({ data: input })
    await recordAudit(tx, {
      adminId,
      action: 'showtime.create',
      targetType: 'Showtime',
      targetId: showtime.id,
    })
    return showtime
  })
}

export async function updateShowtime(
  adminId: string,
  id: string,
  input: { startTime?: Date; endTime?: Date },
) {
  return prisma.$transaction(async (tx) => {
    const showtime = await tx.showtime.update({ where: { id }, data: input })
    await recordAudit(tx, {
      adminId,
      action: 'showtime.update',
      targetType: 'Showtime',
      targetId: id,
    })
    return showtime
  })
}

// Creates the zone and every seat in it in ONE transaction. Creating seats
// one request at a time would leave a half-built zone behind whenever the
// caller stopped partway, and a zone missing seats looks sold out rather
// than broken.
export async function createSeatMap(
  adminId: string,
  input: {
    showtimeId: string
    zoneName: string
    price: number
    rows: string[]
    seatsPerRow: number
  },
) {
  const total = input.rows.length * input.seatsPerRow
  // Checked before opening the transaction — there is no reason to hold a
  // connection open to reject this.
  if (total > MAX_SEATS_PER_SEATMAP) throw new SeatMapTooLargeError()

  const seats = input.rows.flatMap((row) =>
    Array.from({ length: input.seatsPerRow }, (_, i) => ({ row, number: i + 1 })),
  )

  return prisma.$transaction(async (tx) => {
    const seatMap = await tx.seatMap.create({
      data: {
        showtimeId: input.showtimeId,
        zoneName: input.zoneName,
        // Int baht, straight from the validated request. Never a Float.
        price: input.price,
        // No `status` — the Seat schema default (AVAILABLE) is the only
        // thing that may set it. Accepting it from a caller would let an
        // admin mint pre-BOOKED seats.
        seats: { create: seats },
      },
    })
    await recordAudit(tx, {
      adminId,
      action: 'seatmap.create',
      targetType: 'SeatMap',
      targetId: seatMap.id,
    })
    return seatMap
  })
}
```

- [ ] **Step 4: Append the routes to `apps/api/src/routes/admin.ts`**

Extend the import from `../lib/admin.js` with `createShowtime`, `updateShowtime`, `createSeatMap`, `SeatMapTooLargeError`, and add:

```ts
const showtimeCreateSchema = z
  .object({
    eventId: z.string().min(1),
    startTime: z.iso.datetime(),
    endTime: z.iso.datetime(),
  })
  .refine((v) => new Date(v.endTime) > new Date(v.startTime), {
    message: 'endTime must be after startTime',
  })

export const createShowtimeHandler: RequestHandler = async (req, res) => {
  const parsed = showtimeCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const adminId = req.user?.id
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const showtime = await createShowtime(adminId, {
      eventId: parsed.data.eventId,
      startTime: new Date(parsed.data.startTime),
      endTime: new Date(parsed.data.endTime),
    })
    return res.status(201).json({ showtime })
  } catch (err) {
    if (isPrismaCode(err, 'P2003')) return res.status(400).json({ error: 'Unknown eventId' })
    logServerError('POST /admin/showtimes failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

const showtimeUpdateSchema = z
  .object({ startTime: z.iso.datetime().optional(), endTime: z.iso.datetime().optional() })
  .refine((v) => v.startTime !== undefined || v.endTime !== undefined, {
    message: 'At least one field must be provided',
  })

export const updateShowtimeHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' })

  const parsed = showtimeUpdateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const adminId = req.user?.id
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const showtime = await updateShowtime(adminId, id, {
      ...(parsed.data.startTime ? { startTime: new Date(parsed.data.startTime) } : {}),
      ...(parsed.data.endTime ? { endTime: new Date(parsed.data.endTime) } : {}),
    })
    return res.json({ showtime })
  } catch (err) {
    if (isPrismaCode(err, 'P2025')) return res.status(404).json({ error: 'Showtime not found' })
    logServerError('PATCH /admin/showtimes/:id failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

const seatMapCreateSchema = z.object({
  showtimeId: z.string().min(1),
  zoneName: z.string().min(1).max(100),
  // Whole baht. int() rejects 149.5, which would silently become a Float
  // price and break every total in the system.
  price: z.number().int().nonnegative(),
  rows: z.array(z.string().min(1).max(4)).min(1),
  seatsPerRow: z.number().int().positive(),
})

export const createSeatMapHandler: RequestHandler = async (req, res) => {
  const parsed = seatMapCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const adminId = req.user?.id
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    return res.status(201).json({ seatMap: await createSeatMap(adminId, parsed.data) })
  } catch (err) {
    if (err instanceof SeatMapTooLargeError) {
      return res
        .status(400)
        .json({ error: `A seat map may contain at most ${MAX_SEATS_PER_SEATMAP} seats` })
    }
    if (isPrismaCode(err, 'P2003')) return res.status(400).json({ error: 'Unknown showtimeId' })
    // A duplicate (seatMapId, row, number) cannot happen here — the seats are
    // generated, not supplied — so P2002 stays a 500 rather than being
    // swallowed. Never catch a constraint error and continue inside a
    // transaction: Postgres has already aborted it.
    logServerError('POST /admin/seatmaps failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
```

Add `import { MAX_SEATS_PER_SEATMAP } from '../lib/config.js'` at the top of the route file, and register the routes with the others:

```ts
router.post('/showtimes', requireAuth, requireAdmin, createShowtimeHandler)
router.patch('/showtimes/:id', requireAuth, requireAdmin, updateShowtimeHandler)
router.post('/seatmaps', requireAuth, requireAdmin, createSeatMapHandler)
```

- [ ] **Step 5: Run the tests, expect pass**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/admin-seatmap.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS — 160 unit tests, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/admin.ts apps/api/src/routes/admin.ts tests/unit/api/admin-seatmap.test.ts
git commit -m "feat(api): add admin showtime and seat-map endpoints"
```

---

### Task 5: Booking list and dashboard

**Files:**
- Modify: `apps/api/src/lib/admin.ts`
- Modify: `apps/api/src/routes/admin.ts`
- Test: `tests/unit/api/admin-reports.test.ts`
- Test: `tests/integration/admin-dashboard.test.ts`

**Interfaces:**
- Consumes: the router and `lib/admin.ts` from Tasks 3 and 4.
- Produces: `listBookings(filters: { status?: string; email?: string })` and `getDashboard()`.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/unit/api/admin-reports.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ bookingFindMany: vi.fn(), queryRaw: vi.fn() }))

vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: { booking: { findMany: m.bookingFindMany }, $queryRaw: m.queryRaw },
}))

import { listBookings, getDashboard } from '../../../apps/api/src/lib/admin'

beforeEach(() => vi.clearAllMocks())

describe('listBookings', () => {
  it('applies no filter when none is given', async () => {
    m.bookingFindMany.mockResolvedValue([])

    await listBookings({})

    expect(m.bookingFindMany.mock.calls[0][0].where).toEqual({})
  })

  it('filters by status', async () => {
    m.bookingFindMany.mockResolvedValue([])

    await listBookings({ status: 'REFUND_REQUIRED' })

    expect(m.bookingFindMany.mock.calls[0][0].where).toEqual({ status: 'REFUND_REQUIRED' })
  })

  it('filters by email, case-insensitively, on a contains match', async () => {
    m.bookingFindMany.mockResolvedValue([])

    await listBookings({ email: 'somchai' })

    expect(m.bookingFindMany.mock.calls[0][0].where).toEqual({
      user: { email: { contains: 'somchai', mode: 'insensitive' } },
    })
  })

  it('caps the result set', async () => {
    m.bookingFindMany.mockResolvedValue([])

    await listBookings({})

    expect(m.bookingFindMany.mock.calls[0][0].take).toBe(100)
  })
})

describe('getDashboard', () => {
  it('returns one row per showtime from a single query', async () => {
    m.queryRaw.mockResolvedValue([
      {
        showtimeId: 'st1',
        eventTitle: 'คอนเสิร์ต',
        startTime: new Date('2026-09-01T12:00:00Z'),
        totalSeats: 30,
        occupiedSeats: 4,
        revenue: 3000,
      },
    ])

    const rows = await getDashboard()

    expect(m.queryRaw).toHaveBeenCalledTimes(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].revenue).toBe(3000)
  })
})
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/admin-reports.test.ts`
Expected: FAIL — `listBookings is not a function`.

- [ ] **Step 3: Append to `apps/api/src/lib/admin.ts`**

```ts
// LIMITATION: hard `take: 100`, no pagination. Enough at this data size; once
// a real deployment passes 100 bookings the older ones become unreachable
// from this screen and this needs cursor pagination.
const BOOKING_LIST_LIMIT = 100

export async function listBookings(filters: { status?: string; email?: string }) {
  return prisma.booking.findMany({
    where: {
      ...(filters.status ? { status: filters.status as never } : {}),
      ...(filters.email
        ? { user: { email: { contains: filters.email, mode: 'insensitive' as const } } }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: BOOKING_LIST_LIMIT,
    include: {
      user: { select: { email: true, name: true } },
      showtime: { include: { event: { select: { title: true } } } },
      seats: { include: { seat: { select: { row: true, number: true } } } },
    },
  })
}

type DashboardRow = {
  showtimeId: string
  eventTitle: string
  startTime: Date
  totalSeats: number
  occupiedSeats: number
  revenue: number
}

// Seat counts and revenue are aggregated in SEPARATE subqueries on purpose.
// Joining Seat and Booking in one pass multiplies rows against each other and
// inflates both numbers.
//
// The two figures also count different things, and the UI must label them as
// such: occupiedSeats comes from Seat.status, which createBooking sets at
// hold time, so it includes seats held but not yet paid for (correct for
// "how many are left to sell"). revenue counts only PAID bookings, because
// PENDING_PAYMENT is not money yet and REFUND_REQUIRED is money owed back.
// occupiedSeats x price will therefore not equal revenue, and should not.
export async function getDashboard(): Promise<DashboardRow[]> {
  return prisma.$queryRaw<DashboardRow[]>`
    SELECT
      t.id AS "showtimeId",
      e.title AS "eventTitle",
      t."startTime",
      COALESCE(seats.total, 0)::int AS "totalSeats",
      COALESCE(seats.occupied, 0)::int AS "occupiedSeats",
      COALESCE(rev.revenue, 0)::int AS "revenue"
    FROM "Showtime" t
    JOIN "Event" e ON e.id = t."eventId"
    LEFT JOIN (
      SELECT m."showtimeId",
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE s.status = 'BOOKED') AS occupied
      FROM "SeatMap" m
      JOIN "Seat" s ON s."seatMapId" = m.id
      GROUP BY m."showtimeId"
    ) seats ON seats."showtimeId" = t.id
    LEFT JOIN (
      SELECT b."showtimeId", SUM(b."totalPrice") AS revenue
      FROM "Booking" b
      WHERE b.status = 'PAID'
      GROUP BY b."showtimeId"
    ) rev ON rev."showtimeId" = t.id
    ORDER BY t."startTime" DESC
  `
}
```

- [ ] **Step 4: Append the routes to `apps/api/src/routes/admin.ts`**

Extend the `../lib/admin.js` import with `listBookings` and `getDashboard`, then:

```ts
// Mirrors the BookingStatus enum in schema.prisma. An unknown value is the
// caller's mistake, not an empty result set that looks like "no bookings".
const bookingStatusSchema = z.enum([
  'PENDING_PAYMENT',
  'PAID',
  'EXPIRED',
  'CANCELLED',
  'REFUND_REQUIRED',
])

export const listBookingsHandler: RequestHandler = async (req, res) => {
  const { status, email } = req.query

  if (typeof status === 'string') {
    const parsed = bookingStatusSchema.safeParse(status)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  }

  try {
    const bookings = await listBookings({
      status: typeof status === 'string' ? status : undefined,
      email: typeof email === 'string' ? email : undefined,
    })
    return res.json({ bookings })
  } catch (err) {
    logServerError('GET /admin/bookings failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

export const dashboardHandler: RequestHandler = async (_req, res) => {
  try {
    return res.json({ showtimes: await getDashboard() })
  } catch (err) {
    logServerError('GET /admin/dashboard failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
```

and register them:

```ts
router.get('/bookings', requireAuth, requireAdmin, listBookingsHandler)
router.get('/dashboard', requireAuth, requireAdmin, dashboardHandler)
```

- [ ] **Step 5: Write the integration test for the dashboard SQL**

The raw SQL above is the one piece of this phase a mocked unit test cannot check — a wrong join or a missing `FILTER` returns plausible numbers. Create `tests/integration/admin-dashboard.test.ts`, following the structure of `tests/integration/ticket-issuance.test.ts` and using `createFixture` / `deleteFixture` from `tests/integration/helpers.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { prisma } from '../../apps/api/src/lib/prisma'
import { getDashboard } from '../../apps/api/src/lib/admin'
import { createFixture, deleteFixture, type TestFixture } from './helpers'

let fixture: TestFixture

beforeEach(async () => {
  fixture = await createFixture({ withBooking: true })
})

afterEach(async () => {
  await deleteFixture(fixture)
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('getDashboard', () => {
  // createFixture builds one seat, marks it BOOKED, and attaches it to a
  // PENDING_PAYMENT booking — so this pins down the exact distinction the
  // two columns make: the seat counts as occupied, the money does not count
  // as revenue.
  it('counts a held-but-unpaid seat as occupied and excludes it from revenue', async () => {
    const row = (await getDashboard()).find((r) => r.showtimeId === fixture.showtimeId)

    expect(row).toBeDefined()
    expect(row!.totalSeats).toBe(1)
    expect(row!.occupiedSeats).toBe(1)
    expect(row!.revenue).toBe(0)
  })

  it('counts a PAID booking as revenue', async () => {
    await prisma.booking.update({
      where: { id: fixture.bookingId },
      data: { status: 'PAID' },
    })

    const row = (await getDashboard()).find((r) => r.showtimeId === fixture.showtimeId)

    expect(row!.revenue).toBeGreaterThan(0)
    expect(row!.occupiedSeats).toBe(1)
  })

  // The failure a mocked test cannot see: joining Seat and Booking in one
  // pass multiplies the rows and inflates both figures.
  it('does not multiply seat counts by booking counts', async () => {
    await prisma.booking.update({ where: { id: fixture.bookingId }, data: { status: 'PAID' } })
    const extra = await prisma.booking.create({
      data: {
        userId: fixture.userIds[1],
        showtimeId: fixture.showtimeId,
        status: 'PAID',
        totalPrice: 1000,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })

    const row = (await getDashboard()).find((r) => r.showtimeId === fixture.showtimeId)

    // Still one seat in this showtime, no matter how many bookings exist.
    expect(row!.totalSeats).toBe(1)
    expect(row!.occupiedSeats).toBe(1)
    expect(row!.revenue).toBe(2000)

    // Scoped to the row this test made — the dev Postgres is shared.
    await prisma.booking.delete({ where: { id: extra.id } })
  })
})
```

Read `helpers.ts` before writing this — confirm `createFixture` marks the seat `BOOKED` (Phase 4 changed it to), what `totalPrice` it uses, and that `fixture.userIds[1]` exists. Adjust the expected numbers to the fixture's real values rather than the other way round.

- [ ] **Step 6: Run both suites**

Run: `npm test` then `cd apps/api && npm run test:integration`
Expected: 165 unit tests pass; 10 integration tests pass. Check `docker info` first, and **never stop or restart the shared Postgres/Redis containers.**

- [ ] **Step 7: Prove the dashboard test is real**

Change the revenue subquery's `WHERE b.status = 'PAID'` to `WHERE TRUE` and re-run the integration suite. The first test must FAIL on `revenue` being non-zero. Restore it and confirm green. Record both outputs in your report — if it stays green, the test is not testing the filter.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/admin.ts apps/api/src/routes/admin.ts tests/unit/api/admin-reports.test.ts tests/integration/admin-dashboard.test.ts
git commit -m "feat(api): add admin booking list and dashboard"
```

---

### Task 6: Admin pages

**Files:**
- Create: `apps/web/app/admin/page.tsx`
- Create: `apps/web/app/admin/events/page.tsx`
- Create: `apps/web/app/admin/events/[id]/showtimes/page.tsx`
- Create: `apps/web/app/admin/bookings/page.tsx`

**Interfaces:**
- Consumes: `apiFetch` from `@/lib/api`, and the endpoints from Tasks 3-5.
- Produces: nothing other code imports.

**Read `apps/web/app/me/tickets/page.tsx` in full before starting** and match its conventions exactly: `'use client'`, `useEffect` with a `cancelled` flag, `try/catch` around `apiFetch` with a Thai connection-error message, `router.push('/login')` on 401. All copy is Thai; dates via `toLocaleString('th-TH')`; every input has a `<label htmlFor>`.

**Read the response shapes from `apps/api/src/lib/admin.ts` rather than assuming them** — write your TypeScript types from what the API actually returns.

**On guarding:** the API answers `404` to a non-admin. The pages treat a 404 as "you should not be here" and redirect to `/`. That is UX only. **Never gate anything on a role value held in the browser** — `requireAdmin` on the server is the actual guard, and the pages must remain correct even if someone edits their client state.

- [ ] **Step 1: Create `apps/web/app/admin/page.tsx` — the dashboard**

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiFetch } from '@/lib/api'

type Row = {
  showtimeId: string
  eventTitle: string
  startTime: string
  totalSeats: number
  occupiedSeats: number
  revenue: number
}

export default function AdminDashboardPage() {
  const router = useRouter()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let res: Response
      try {
        res = await apiFetch('/admin/dashboard')
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
      // The API answers 404 to anyone who is not an admin.
      if (res.status === 404) {
        router.push('/')
        return
      }
      if (!res.ok) {
        setError('โหลดข้อมูลไม่สำเร็จ')
        return
      }
      const data = await res.json()
      if (cancelled) return
      setRows(data.showtimes)
    })()
    return () => {
      cancelled = true
    }
  }, [router])

  if (error) {
    return (
      <main className="mx-auto max-w-4xl p-8">
        <p className="text-red-600">{error}</p>
      </main>
    )
  }
  if (rows === null) {
    return (
      <main className="mx-auto max-w-4xl p-8">
        <p>กำลังโหลด…</p>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-4xl p-8 flex flex-col gap-4">
      <h1 className="text-2xl font-bold">ภาพรวม</h1>
      <nav className="flex gap-4 text-sm">
        <Link href="/admin/events" className="underline">
          จัดการ event
        </Link>
        <Link href="/admin/bookings" className="underline">
          รายการจอง
        </Link>
      </nav>

      {rows.length === 0 ? (
        <p>ยังไม่มีรอบการแสดง</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left border-b">
                <th className="p-2">รอบ</th>
                <th className="p-2">เวลาเริ่ม</th>
                <th className="p-2">ที่นั่งทั้งหมด</th>
                <th className="p-2">ที่นั่งไม่ว่าง</th>
                <th className="p-2">ยอดขาย (จ่ายแล้ว)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.showtimeId} className="border-b">
                  <td className="p-2">{r.eventTitle}</td>
                  <td className="p-2">
                    {new Date(r.startTime).toLocaleString('th-TH', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </td>
                  <td className="p-2">{r.totalSeats}</td>
                  <td className="p-2">{r.occupiedSeats}</td>
                  <td className="p-2">{r.revenue.toLocaleString('th-TH')} บาท</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* The two figures count different things — see lib/admin.ts. Saying so
          on screen stops someone reporting a bug that is not one. */}
      <p className="text-xs text-gray-600">
        “ที่นั่งไม่ว่าง” นับรวมที่นั่งที่ถูกจองไว้แต่ยังไม่ได้ชำระเงิน ส่วน “ยอดขาย”
        นับเฉพาะการจองที่ชำระเงินแล้ว ตัวเลขสองคอลัมน์นี้จึงไม่จำเป็นต้องสอดคล้องกัน
      </p>
    </main>
  )
}
```

- [ ] **Step 2: Create `apps/web/app/admin/events/page.tsx`**

A list of events with a create form and a venue create form. Follow the same fetch/error/redirect shape as Step 1. It fetches `/admin/events` and `/admin/venues` on mount, and posts to `/admin/events` and `/admin/venues`. Each event row links to `/admin/events/{id}/showtimes`.

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiFetch } from '@/lib/api'

type Venue = { id: string; name: string; address: string }
type EventRow = {
  id: string
  title: string
  description: string
  venue: { name: string }
  showtimes: { id: string }[]
}

export default function AdminEventsPage() {
  const router = useRouter()
  const [venues, setVenues] = useState<Venue[] | null>(null)
  const [events, setEvents] = useState<EventRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [venueName, setVenueName] = useState('')
  const [venueAddress, setVenueAddress] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [venueId, setVenueId] = useState('')

  async function load(): Promise<void> {
    let vres: Response
    let eres: Response
    try {
      ;[vres, eres] = await Promise.all([apiFetch('/admin/venues'), apiFetch('/admin/events')])
    } catch (err) {
      console.error(err)
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
      return
    }
    if (vres.status === 401 || eres.status === 401) {
      router.push('/login')
      return
    }
    if (vres.status === 404 || eres.status === 404) {
      router.push('/')
      return
    }
    if (!vres.ok || !eres.ok) {
      setError('โหลดข้อมูลไม่สำเร็จ')
      return
    }
    setVenues((await vres.json()).venues)
    setEvents((await eres.json()).events)
  }

  useEffect(() => {
    void load()
    // load() is defined in this component and only touches state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submit(path: string, body: unknown): Promise<boolean> {
    setSubmitting(true)
    setFormError(null)
    let res: Response
    try {
      res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) })
    } catch (err) {
      console.error(err)
      setFormError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
      setSubmitting(false)
      return false
    }
    setSubmitting(false)
    if (res.status === 401) {
      router.push('/login')
      return false
    }
    if (!res.ok) {
      setFormError('บันทึกไม่สำเร็จ กรุณาตรวจสอบข้อมูล')
      return false
    }
    return true
  }

  if (error) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="text-red-600">{error}</p>
      </main>
    )
  }
  if (venues === null || events === null) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p>กำลังโหลด…</p>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-3xl p-8 flex flex-col gap-8">
      <h1 className="text-2xl font-bold">จัดการ event</h1>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">เพิ่มสถานที่</h2>
        <label htmlFor="venue-name">ชื่อสถานที่</label>
        <input
          id="venue-name"
          value={venueName}
          onChange={(e) => setVenueName(e.target.value)}
          className="border p-2 rounded"
        />
        <label htmlFor="venue-address">ที่อยู่</label>
        <input
          id="venue-address"
          value={venueAddress}
          onChange={(e) => setVenueAddress(e.target.value)}
          className="border p-2 rounded"
        />
        <button
          type="button"
          disabled={submitting}
          onClick={async () => {
            if (await submit('/admin/venues', { name: venueName, address: venueAddress })) {
              setVenueName('')
              setVenueAddress('')
              await load()
            }
          }}
          className="bg-black text-white p-2 rounded disabled:bg-gray-400"
        >
          บันทึกสถานที่
        </button>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">เพิ่ม event</h2>
        <label htmlFor="event-title">ชื่อ event</label>
        <input
          id="event-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="border p-2 rounded"
        />
        <label htmlFor="event-description">รายละเอียด</label>
        <textarea
          id="event-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="border p-2 rounded"
        />
        <label htmlFor="event-venue">สถานที่</label>
        <select
          id="event-venue"
          value={venueId}
          onChange={(e) => setVenueId(e.target.value)}
          className="border p-2 rounded"
        >
          <option value="">เลือกสถานที่</option>
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={submitting}
          onClick={async () => {
            if (await submit('/admin/events', { title, description, venueId })) {
              setTitle('')
              setDescription('')
              setVenueId('')
              await load()
            }
          }}
          className="bg-black text-white p-2 rounded disabled:bg-gray-400"
        >
          บันทึก event
        </button>
        {formError && <p className="text-red-600">{formError}</p>}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">event ทั้งหมด</h2>
        <ul className="flex flex-col gap-2">
          {events.map((e) => (
            <li key={e.id} className="border rounded p-3">
              <div className="font-semibold">{e.title}</div>
              <div className="text-sm">{e.venue.name}</div>
              <div className="text-sm">{e.showtimes.length} รอบ</div>
              <Link href={`/admin/events/${e.id}/showtimes`} className="text-sm underline">
                จัดการรอบและผังที่นั่ง
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
```

- [ ] **Step 3: Create `apps/web/app/admin/events/[id]/showtimes/page.tsx`**

Same conventions. It reads the event's showtimes from `/admin/events` (filtering client-side by the route id — a display concern, not business logic), posts a new showtime to `/admin/showtimes`, and posts a seat map to `/admin/seatmaps`.

The seat-map form takes: showtime (select), zone name, price (number), rows (comma-separated text, split on `,` and trimmed), and seats per row (number). Show the resulting seat count next to the button so an admin sees it before submitting, and surface the API's 400 message verbatim when the cap is exceeded — the server owns that limit, the page must not hardcode 100.

Follow Step 2's `load()` / `submit()` shape exactly rather than inventing a new one.

- [ ] **Step 4: Create `apps/web/app/admin/bookings/page.tsx`**

A table of bookings with two filter controls: a status `<select>` (empty option plus the five `BookingStatus` values) and an email text input, both feeding the query string of `/admin/bookings`. Columns: booking id, customer email, event, showtime, seats, total price, status, created at.

Render `REFUND_REQUIRED` visibly distinct (e.g. red text) **and with a text label, not colour alone** — the project's accessibility rule. Add a line of Thai copy stating that refunds are processed manually in the payment provider's dashboard, because there is no refund button here by design.

Follow Step 2's conventions for fetching, 401 → `/login`, 404 → `/`.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS, no type errors in either workspace.

- [ ] **Step 6: Manual check**

With `npm run dev:api` and `npm run dev:web` running, and an admin seeded (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` set, then `cd apps/api && npx prisma db seed`):

1. Log in as a **normal** user and open `/admin` → must redirect to `/`, and the network tab must show `404`, not `403`.
2. Log in as the admin → the dashboard renders with real numbers.
3. Create a venue, an event, a showtime, and a seat map. Confirm the seats appear on the public `/showtimes/{id}/seats` page.
4. Ask for a seat map larger than the cap → the page shows the server's error, and no partial zone is created.
5. Open `/admin/bookings`, filter by status and by email.
6. Check `AdminAuditLog` has one row per mutation you performed, with the admin's id.

Shut down any dev server you started. Report exactly which of these you performed and which you could not.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/admin
git commit -m "feat(web): add admin dashboard, catalog, and booking pages"
```

---

## Definition of Done

Per `CLAUDE.md` §6, this phase is done only when:

1. `npm run build` clean in both workspaces.
2. `npm test` green (165 unit tests) and `cd apps/api && npm run test:integration` green (10 tests).
3. The Task 6 manual checklist walked at least once.
4. A summary stating what was built, what was deliberately skipped, and what a human must review.

**One Phase 5 checklist item from the plan document cannot be closed, and the summary must say so rather than implying it passed:**

- **"คืนเงินแล้ว seat กลับมาว่างถูกต้อง"** — there is no refund feature. It was cut by an explicit human decision on 12 Aug 2026. Report it as **cut**, not as passed.

## Deliberately out of scope

| Skipped | Add when |
|---|---|
| Refund (endpoint + provider call) | Cut permanently, 12 Aug 2026 |
| Cancel showtime | `createBooking` must first lock the `Showtime` row (order: Showtime → Seat, to stay compatible with `applyPaymentOutcome`'s Booking → Payment → Seat), with an integration test that books and cancels concurrently. See the spec. |
| Any `DELETE` endpoint | A real need, plus human approval — `CLAUDE.md` §5 |
| Charts on the dashboard | The table stops being enough |
| CSV export | Someone asks |
| Pagination on bookings / events | A real list passes 100 rows |
| Editing a zone's price after it has sold seats | Someone asks — and decide first what happens to bookings already paid at the old price |
