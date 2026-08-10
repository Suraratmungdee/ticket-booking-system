# Phase 2 — Seat Hold + Booking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in user pick seats from a showtime's seat map and create a `PENDING_PAYMENT` booking that holds those seats for 5 minutes, with a proven guarantee that two people clicking the same seat simultaneously produce exactly one booking.

**Architecture:** Redis is a fast-fail first gate (`SET NX EX`); Postgres `SELECT ... FOR UPDATE` on `Seat` rows inside one transaction is the authority. A total Redis outage degrades speed, never correctness.

**Spec:** `docs/superpowers/specs/2026-08-10-phase2-seats-booking-design.md` — read it before starting.

**Tech Stack:** Express 5 + TypeScript (ESM/NodeNext), Prisma v6, PostgreSQL, Redis (`redis` npm client), Next.js 16 App Router, Tailwind v4, Vitest.

## Global Constraints

- Repo is npm workspaces: `apps/api` (backend, owns all business logic and DB access) and `apps/web` (UI only — no business logic, no DB, no direct Redis).
- `apps/api/src` is ESM with `moduleResolution: NodeNext` — **every relative import needs a `.js` extension** (`from './config.js'`). Files under `tests/` do not.
- `apps/web` uses bundler resolution — no extensions.
- All business constants live in `apps/api/src/lib/config.ts`. Hardcoding one in a route or lib is a defect.
- Money and seat-state logic lives in `apps/api/src/lib` as shared functions every route calls. Never duplicate validation across routes.
- **Prices are always read from `SeatMap.price` in the database. Never trust a price sent by the client.**
- Every endpoint touching seats or bookings validates input with zod and re-checks state against the DB before writing.
- Seat/booking state changes happen in ONE transaction. Never split them across queries.
- Route error style matches `apps/api/src/routes/events.ts`: zod `safeParse` at the top returning `400` with `parsed.error.flatten()`, `try/catch` ending in `logServerError(...)` plus a generic `500 { error: 'Internal server error' }`.
- Not-owner returns **404**, never 403 — so booking ids cannot be probed.
- The only new runtime dependency permitted by this plan is `redis`. Anything else requires human approval — stop and ask.
- Migrations are additive. No `DROP COLUMN`/`DROP TABLE` without approval.
- No secrets committed. `.env` is gitignored; `.env.example` carries placeholders only.
- Deliberate corner-cuts carry a `// ponytail:` or `// LIMITATION:` comment naming the ceiling and upgrade path.
- Branching logic needs at least one test that genuinely fails if the logic breaks.
- `SEAT_HOLD_TTL_SECONDS = 300`, `MAX_SEATS_PER_BOOKING = 8`.
- Seat map per showtime: 3 zones × 5 rows × 6 seats = 90 seats. VIP 3500, ธรรมดา 2000, ยืน 1200.

---

### Task 1: Redis service, client, and config constants

**Files:**
- Modify: `docker-compose.yml`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/src/lib/config.ts`
- Create: `apps/api/src/lib/redis.ts`

**Interfaces:**
- Produces: `config.ts` gains `SEAT_HOLD_TTL_SECONDS: number`, `MAX_SEATS_PER_BOOKING: number`, `REDIS_URL: string`.
- Produces: `redis.ts` exports `getRedis(): Promise<RedisClientType>` (lazily connects a singleton) and `closeRedis(): Promise<void>` (for test teardown).

- [ ] **Step 1: Add the Redis service to `docker-compose.yml`**

Add alongside the existing `postgres` service, at the same indentation:

```yaml
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

No volume: seat holds are ephemeral by design and must not survive a restart.

- [ ] **Step 2: Install the client**

Run: `npm install redis --workspace apps/api`

- [ ] **Step 3: Add env placeholders to `apps/api/.env.example`**

Append:

```
REDIS_URL="redis://localhost:6379"
```

Then mirror it into your local `apps/api/.env` (gitignored — never commit it).

- [ ] **Step 4: Append constants to `apps/api/src/lib/config.ts`**

```ts
// How long a seat stays held for one user before it returns to the pool.
// Long enough to finish a checkout form, short enough that an abandoned
// cart doesn't hoard seats. Mirrored as the Redis key TTL.
export const SEAT_HOLD_TTL_SECONDS = 300

// Cap on seats per booking, so one request cannot sweep a whole zone.
export const MAX_SEATS_PER_BOOKING = 8

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
```

- [ ] **Step 5: Create `apps/api/src/lib/redis.ts`**

```ts
import { createClient, type RedisClientType } from 'redis'
import { REDIS_URL } from './config.js'

let client: RedisClientType | null = null

// Lazily connected singleton. Connecting on first use (rather than at import
// time) keeps the unit tests — which mock this module — from ever opening a
// socket, and lets the API boot even when Redis is not up yet.
export async function getRedis(): Promise<RedisClientType> {
  if (!client) {
    client = createClient({ url: REDIS_URL })
    client.on('error', (err) => console.error('[redis]', err instanceof Error ? err.message : err))
    await client.connect()
  }
  return client
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit()
    client = null
  }
}
```

- [ ] **Step 6: Verify**

Run:
```bash
docker compose up -d redis
docker exec $(docker compose ps -q redis) redis-cli ping
cd apps/api && npx tsc --noEmit
```
Expected: `PONG`, and no type errors.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml apps/api/.env.example apps/api/src/lib/config.ts apps/api/src/lib/redis.ts package-lock.json apps/api/package.json
git commit -m "feat(api): add Redis service, client singleton, and seat-hold constants"
```

---

### Task 2: Prisma schema for seats and bookings

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_seats_and_bookings/migration.sql` (generated)
- Modify: `apps/api/prisma/seed.ts`

**Interfaces:**
- Produces: Prisma models `SeatMap`, `Seat`, `Booking`, `BookingSeat` and enums `SeatStatus`, `BookingStatus` — consumed by Tasks 4, 5, 6.

- [ ] **Step 1: Append to `apps/api/prisma/schema.prisma`**

```prisma
enum SeatStatus {
  AVAILABLE
  BOOKED
}

enum BookingStatus {
  PENDING_PAYMENT
  PAID
  EXPIRED
  CANCELLED
}

model SeatMap {
  id         String   @id @default(cuid())
  showtimeId String
  showtime   Showtime @relation(fields: [showtimeId], references: [id])
  zoneName   String
  price      Int
  seats      Seat[]
}

model Seat {
  id        String        @id @default(cuid())
  seatMapId String
  seatMap   SeatMap       @relation(fields: [seatMapId], references: [id])
  row       String
  number    Int
  status    SeatStatus    @default(AVAILABLE)
  bookings  BookingSeat[]

  @@unique([seatMapId, row, number])
}

model Booking {
  id         String        @id @default(cuid())
  userId     String
  user       User          @relation(fields: [userId], references: [id])
  showtimeId String
  showtime   Showtime      @relation(fields: [showtimeId], references: [id])
  status     BookingStatus @default(PENDING_PAYMENT)
  totalPrice Int
  createdAt  DateTime      @default(now())
  expiresAt  DateTime
  seats      BookingSeat[]

  @@index([status, expiresAt])
}

model BookingSeat {
  id        String  @id @default(cuid())
  bookingId String
  booking   Booking @relation(fields: [bookingId], references: [id])
  seatId    String
  seat      Seat    @relation(fields: [seatId], references: [id])

  @@unique([bookingId, seatId])
}
```

`price` and `totalPrice` are `Int` (satang-free whole baht) — floating point must never hold money.

- [ ] **Step 2: Add the missing back-relations**

Prisma requires both sides. Add to the existing models:

```prisma
model User {
  // ...existing fields unchanged...
  bookings Booking[]
}

model Showtime {
  // ...existing fields unchanged...
  seatMaps  SeatMap[]
  bookings  Booking[]
}
```

- [ ] **Step 3: Create and apply the migration**

Run:
```bash
docker compose up -d postgres
cd apps/api && npx prisma migrate dev --name seats_and_bookings
```
Expected: a new migration directory is created and applied, and the client regenerates. The migration must be purely additive — read the generated `migration.sql` and confirm it contains no `DROP`.

- [ ] **Step 4: Extend `apps/api/prisma/seed.ts` to build seat maps**

Add above the final `console.log`, after the events exist:

```ts
const ZONES = [
  { zoneName: 'VIP', price: 3500 },
  { zoneName: 'ธรรมดา', price: 2000 },
  { zoneName: 'ยืน', price: 1200 },
]
const ROWS = ['A', 'B', 'C', 'D', 'E']
const SEATS_PER_ROW = 6

const showtimes = await prisma.showtime.findMany({ select: { id: true } })
for (const showtime of showtimes) {
  for (const zone of ZONES) {
    await prisma.seatMap.create({
      data: {
        showtimeId: showtime.id,
        zoneName: zone.zoneName,
        price: zone.price,
        seats: {
          create: ROWS.flatMap((row) =>
            Array.from({ length: SEATS_PER_ROW }, (_, i) => ({ row, number: i + 1 })),
          ),
        },
      },
    })
  }
}
console.log(`Seeded ${showtimes.length} showtimes x ${ZONES.length} zones x ${ROWS.length * SEATS_PER_ROW} seats`)
```

Also extend the existing delete block at the top of `main()` so re-seeding stays idempotent. Order matters — children first:

```ts
await prisma.bookingSeat.deleteMany()
await prisma.booking.deleteMany()
await prisma.seat.deleteMany()
await prisma.seatMap.deleteMany()
await prisma.showtime.deleteMany()
await prisma.event.deleteMany()
await prisma.venue.deleteMany()
```

- [ ] **Step 5: Run the seed and verify counts**

Run:
```bash
cd apps/api && npx prisma db seed
docker exec $(docker compose -f ../../docker-compose.yml ps -q postgres) \
  psql -U ticket -d ticket_booking -tAc 'SELECT count(*) FROM "Seat";'
```
Expected: 5 showtimes × 3 zones × 30 seats = **450**.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma
git commit -m "feat(api): add SeatMap/Seat/Booking/BookingSeat schema and seat seeding"
```

---

### Task 3: Auth middleware

**Files:**
- Create: `apps/api/src/middleware/auth.ts`
- Test: `tests/unit/api/auth-middleware.test.ts`

**Interfaces:**
- Consumes: `JWT_SECRET`, `JWT_COOKIE_NAME` from `apps/api/src/lib/config.ts`.
- Produces: `requireAuth: RequestHandler` which verifies the JWT cookie and sets `req.user = { id: string; role: string }`, or responds `401 { error: 'Unauthorized' }`. Also produces the module augmentation making `req.user` typed. Consumed by Task 6.

Phase 1 issued tokens but never verified one — this is the first consumer.

- [ ] **Step 1: Write the failing test — `tests/unit/api/auth-middleware.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { requireAuth } from '../../../apps/api/src/middleware/auth'
import { JWT_SECRET, JWT_COOKIE_NAME } from '../../../apps/api/src/lib/config'

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() } as any
  res.status.mockReturnValue(res)
  res.json.mockReturnValue(res)
  return res
}

beforeEach(() => vi.clearAllMocks())

describe('requireAuth', () => {
  it('sets req.user and calls next() for a valid token', () => {
    const token = jwt.sign({ sub: 'user-1', role: 'USER' }, JWT_SECRET, { expiresIn: 60 })
    const req = { cookies: { [JWT_COOKIE_NAME]: token } } as any
    const res = makeRes()
    const next = vi.fn()

    requireAuth(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.user).toEqual({ id: 'user-1', role: 'USER' })
    expect(res.status).not.toHaveBeenCalled()
  })

  it('rejects a request with no cookie', () => {
    const req = { cookies: {} } as any
    const res = makeRes()
    const next = vi.fn()

    requireAuth(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it('rejects a token signed with the wrong secret', () => {
    const token = jwt.sign({ sub: 'user-1', role: 'USER' }, 'not-the-real-secret', { expiresIn: 60 })
    const req = { cookies: { [JWT_COOKIE_NAME]: token } } as any
    const res = makeRes()
    const next = vi.fn()

    requireAuth(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
  })

  it('rejects an expired token', () => {
    const token = jwt.sign({ sub: 'user-1', role: 'USER' }, JWT_SECRET, { expiresIn: -10 })
    const req = { cookies: { [JWT_COOKIE_NAME]: token } } as any
    const res = makeRes()
    const next = vi.fn()

    requireAuth(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/api && npx vitest run`
Expected: FAIL — `Cannot find module '../../../apps/api/src/middleware/auth'`.

- [ ] **Step 3: Create `apps/api/src/middleware/auth.ts`**

```ts
import type { RequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import { JWT_SECRET, JWT_COOKIE_NAME } from '../lib/config.js'

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; role: string }
    }
  }
}

// Verifies the httpOnly JWT cookie issued by POST /auth/login. Every reply is
// the same opaque 401 whether the cookie is missing, malformed, expired, or
// forged — a caller learns nothing about why.
export const requireAuth: RequestHandler = (req, res, next) => {
  const token = req.cookies?.[JWT_COOKIE_NAME]
  if (typeof token !== 'string') {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET)
    if (typeof payload === 'string' || typeof payload.sub !== 'string') {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    req.user = { id: payload.sub, role: String(payload.role ?? 'USER') }
    return next()
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/auth.ts tests/unit/api/auth-middleware.test.ts
git commit -m "feat(api): add JWT auth middleware"
```

---

### Task 4: Seat-lock library (Redis)

**Files:**
- Create: `apps/api/src/lib/seat-lock.ts`
- Test: `tests/unit/api/seat-lock.test.ts`

**Interfaces:**
- Consumes: `getRedis` from `./redis.js`; `SEAT_HOLD_TTL_SECONDS` from `./config.js`.
- Produces:
  - `acquireSeatHolds(seatIds: string[], userId: string): Promise<boolean>` — all-or-nothing. Returns `true` only if every seat was locked; on any failure it releases the ones it just took and returns `false`.
  - `releaseSeatHolds(seatIds: string[]): Promise<void>`
  - `getHeldSeatIds(seatIds: string[]): Promise<Set<string>>` — one `MGET`, not N round trips.
  - Consumed by Tasks 5 and 6.

- [ ] **Step 1: Write the failing test — `tests/unit/api/seat-lock.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSet = vi.fn()
const mockDel = vi.fn()
const mockMGet = vi.fn()

vi.mock('../../../apps/api/src/lib/redis', () => ({
  getRedis: async () => ({ set: mockSet, del: mockDel, mGet: mockMGet }),
}))

import {
  acquireSeatHolds,
  releaseSeatHolds,
  getHeldSeatIds,
} from '../../../apps/api/src/lib/seat-lock'

beforeEach(() => {
  mockSet.mockReset()
  mockDel.mockReset()
  mockMGet.mockReset()
})

describe('acquireSeatHolds', () => {
  it('returns true and locks every seat when all are free', async () => {
    mockSet.mockResolvedValue('OK')

    const ok = await acquireSeatHolds(['s1', 's2'], 'user-1')

    expect(ok).toBe(true)
    expect(mockSet).toHaveBeenCalledTimes(2)
    expect(mockDel).not.toHaveBeenCalled()
  })

  it('uses NX and a TTL so a crashed request cannot hold a seat forever', async () => {
    mockSet.mockResolvedValue('OK')

    await acquireSeatHolds(['s1'], 'user-1')

    expect(mockSet).toHaveBeenCalledWith(
      'hold:seat:s1',
      'user-1',
      expect.objectContaining({ NX: true, EX: 300 }),
    )
  })

  // The bug this whole function exists to prevent: partial acquisition that
  // strands the seats it did take for the full TTL.
  it('releases already-acquired seats when a later seat is taken', async () => {
    mockSet.mockResolvedValueOnce('OK').mockResolvedValueOnce('OK').mockResolvedValueOnce(null)

    const ok = await acquireSeatHolds(['s1', 's2', 's3'], 'user-1')

    expect(ok).toBe(false)
    expect(mockDel).toHaveBeenCalledWith(['hold:seat:s1', 'hold:seat:s2'])
  })

  it('does not release anything when the very first seat is taken', async () => {
    mockSet.mockResolvedValueOnce(null)

    const ok = await acquireSeatHolds(['s1', 's2'], 'user-1')

    expect(ok).toBe(false)
    expect(mockDel).not.toHaveBeenCalled()
    expect(mockSet).toHaveBeenCalledTimes(1)
  })
})

describe('getHeldSeatIds', () => {
  it('returns only the seats with a live hold, in one MGET', async () => {
    mockMGet.mockResolvedValue(['user-1', null, 'user-2'])

    const held = await getHeldSeatIds(['s1', 's2', 's3'])

    expect(mockMGet).toHaveBeenCalledOnce()
    expect(held).toEqual(new Set(['s1', 's3']))
  })

  it('returns an empty set for an empty input without calling Redis', async () => {
    const held = await getHeldSeatIds([])

    expect(held.size).toBe(0)
    expect(mockMGet).not.toHaveBeenCalled()
  })
})

describe('releaseSeatHolds', () => {
  it('does nothing for an empty list', async () => {
    await releaseSeatHolds([])
    expect(mockDel).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/api && npx vitest run`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `apps/api/src/lib/seat-lock.ts`**

```ts
import { getRedis } from './redis.js'
import { SEAT_HOLD_TTL_SECONDS } from './config.js'

const key = (seatId: string) => `hold:seat:${seatId}`

// Takes a short-lived hold on every seat or none at all.
//
// The all-or-nothing part is the point: acquiring 2 of 3 seats and returning
// false without releasing those 2 would strand them for the full TTL, which
// users see as "the seat looks free but I can't select it".
//
// This is a first gate for fast failure and a better error message, NOT the
// correctness guarantee — Postgres's `SELECT ... FOR UPDATE` in
// lib/booking.ts is. If Redis is down or wrong, booking stays correct.
export async function acquireSeatHolds(seatIds: string[], userId: string): Promise<boolean> {
  if (seatIds.length === 0) return true
  const redis = await getRedis()
  const acquired: string[] = []

  for (const seatId of seatIds) {
    const result = await redis.set(key(seatId), userId, {
      NX: true,
      EX: SEAT_HOLD_TTL_SECONDS,
    })
    if (result !== 'OK') {
      if (acquired.length > 0) await redis.del(acquired)
      return false
    }
    acquired.push(key(seatId))
  }

  return true
}

export async function releaseSeatHolds(seatIds: string[]): Promise<void> {
  if (seatIds.length === 0) return
  const redis = await getRedis()
  await redis.del(seatIds.map(key))
}

// One MGET rather than N round trips, so rendering a 90-seat map costs a
// single Redis call.
export async function getHeldSeatIds(seatIds: string[]): Promise<Set<string>> {
  if (seatIds.length === 0) return new Set()
  const redis = await getRedis()
  const values = await redis.mGet(seatIds.map(key))
  const held = new Set<string>()
  values.forEach((value, i) => {
    if (value !== null) held.add(seatIds[i])
  })
  return held
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/seat-lock.ts tests/unit/api/seat-lock.test.ts
git commit -m "feat(api): add Redis seat-hold library with all-or-nothing acquisition"
```

---

### Task 5: Booking library — the transaction that guarantees no double-booking

**Files:**
- Create: `apps/api/src/lib/booking.ts`
- Test: `tests/unit/api/booking.test.ts`

**Interfaces:**
- Consumes: `prisma` from `./prisma.js`; `acquireSeatHolds`/`releaseSeatHolds` from `./seat-lock.js`; `MAX_SEATS_PER_BOOKING`, `SEAT_HOLD_TTL_SECONDS` from `./config.js`.
- Produces:
  - `createBooking(input: { userId: string; showtimeId: string; seatIds: string[] }): Promise<BookingResult>`
  - `expireStaleBookings(): Promise<number>` — returns how many bookings expired.
  - `getBookingForUser(bookingId: string, userId: string)` — returns `null` when missing OR not owned.
  - Errors `SeatUnavailableError`, `TooManySeatsError`, `SeatsNotInShowtimeError`.
  - Consumed by Task 6.

- [ ] **Step 1: Write the failing test — `tests/unit/api/booking.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAcquire = vi.fn()
const mockRelease = vi.fn()
vi.mock('../../../apps/api/src/lib/seat-lock', () => ({
  acquireSeatHolds: mockAcquire,
  releaseSeatHolds: mockRelease,
}))

const mockQueryRaw = vi.fn()
const mockTransaction = vi.fn()
const mockBookingCreate = vi.fn()
const mockSeatUpdateMany = vi.fn()
const mockBookingFindFirst = vi.fn()
vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: {
    $transaction: mockTransaction,
    $queryRaw: mockQueryRaw,
    booking: { create: mockBookingCreate, findFirst: mockBookingFindFirst },
    seat: { updateMany: mockSeatUpdateMany },
  },
}))

import {
  createBooking,
  getBookingForUser,
  SeatUnavailableError,
  TooManySeatsError,
} from '../../../apps/api/src/lib/booking'

// Runs the callback against a tx stub exposing the same shape the real
// transaction client does.
function txRuns(tx: Record<string, unknown>) {
  mockTransaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAcquire.mockResolvedValue(true)
})

describe('createBooking', () => {
  it('rejects more seats than the per-booking cap before touching Redis or the DB', async () => {
    await expect(
      createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: Array.from({ length: 9 }, (_, i) => `s${i}`) }),
    ).rejects.toThrow(TooManySeatsError)

    expect(mockAcquire).not.toHaveBeenCalled()
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it('throws SeatUnavailableError when Redis says a seat is already held', async () => {
    mockAcquire.mockResolvedValue(false)

    await expect(
      createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: ['s1'] }),
    ).rejects.toThrow(SeatUnavailableError)

    expect(mockTransaction).not.toHaveBeenCalled()
  })

  // Redis said yes but Postgres is the authority and disagrees.
  it('releases the Redis holds when the DB finds a seat already booked', async () => {
    txRuns({
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 's1', status: 'BOOKED', price: 2000, showtimeId: 'st1' },
      ]),
    })

    await expect(
      createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: ['s1'] }),
    ).rejects.toThrow(SeatUnavailableError)

    expect(mockRelease).toHaveBeenCalledWith(['s1'])
  })

  it('computes totalPrice from the DB rows, not from anything the caller supplied', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'b1' })
    txRuns({
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 's1', status: 'AVAILABLE', price: 3500, showtimeId: 'st1' },
        { id: 's2', status: 'AVAILABLE', price: 1200, showtimeId: 'st1' },
      ]),
      seat: { updateMany: vi.fn() },
      booking: { create },
    })

    await createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: ['s1', 's2'] })

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ totalPrice: 4700 }) }),
    )
  })

  it('rejects seats that belong to a different showtime', async () => {
    txRuns({
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 's1', status: 'AVAILABLE', price: 2000, showtimeId: 'OTHER' },
      ]),
    })

    await expect(
      createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: ['s1'] }),
    ).rejects.toThrow(SeatUnavailableError)
    expect(mockRelease).toHaveBeenCalled()
  })
})

describe('getBookingForUser', () => {
  it('returns null when the booking belongs to someone else', async () => {
    mockBookingFindFirst.mockResolvedValue(null)

    const result = await getBookingForUser('b1', 'someone-else')

    expect(result).toBeNull()
    expect(mockBookingFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'b1', userId: 'someone-else' }) }),
    )
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/api && npx vitest run`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `apps/api/src/lib/booking.ts`**

```ts
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { acquireSeatHolds, releaseSeatHolds } from './seat-lock.js'
import { MAX_SEATS_PER_BOOKING, SEAT_HOLD_TTL_SECONDS } from './config.js'

export class SeatUnavailableError extends Error {}
export class TooManySeatsError extends Error {}

type LockedSeat = { id: string; status: string; price: number; showtimeId: string }

export async function createBooking(input: {
  userId: string
  showtimeId: string
  seatIds: string[]
}) {
  if (input.seatIds.length > MAX_SEATS_PER_BOOKING) throw new TooManySeatsError()

  // First gate: cheap, fast, and keeps most contenders out of the DB.
  const held = await acquireSeatHolds(input.seatIds, input.userId)
  if (!held) throw new SeatUnavailableError()

  try {
    return await prisma.$transaction(async (tx) => {
      // The authority. FOR UPDATE blocks any concurrent transaction asking for
      // these same rows until we commit, so the status we read cannot go stale
      // between the check and the write — the check-then-act race that makes
      // naive seat booking double-book under load.
      //
      // ORDER BY id is not cosmetic: two requests selecting the same seats in
      // different orders would each hold one row and wait on the other's,
      // deadlocking. A single global order makes that impossible.
      const seats = await tx.$queryRaw<LockedSeat[]>`
        SELECT s.id, s.status::text AS status, m.price, m."showtimeId"
        FROM "Seat" s
        JOIN "SeatMap" m ON m.id = s."seatMapId"
        WHERE s.id = ANY(${input.seatIds}::text[])
        ORDER BY s.id
        FOR UPDATE OF s
      `

      if (seats.length !== input.seatIds.length) throw new SeatUnavailableError()
      if (seats.some((s) => s.status !== 'AVAILABLE')) throw new SeatUnavailableError()
      if (seats.some((s) => s.showtimeId !== input.showtimeId)) throw new SeatUnavailableError()

      // Price comes from the joined SeatMap rows we just locked — never from
      // the request body.
      const totalPrice = seats.reduce((sum, s) => sum + s.price, 0)

      await tx.seat.updateMany({
        where: { id: { in: input.seatIds } },
        data: { status: 'BOOKED' },
      })

      return await tx.booking.create({
        data: {
          userId: input.userId,
          showtimeId: input.showtimeId,
          status: 'PENDING_PAYMENT',
          totalPrice,
          expiresAt: new Date(Date.now() + SEAT_HOLD_TTL_SECONDS * 1000),
          seats: { create: input.seatIds.map((seatId) => ({ seatId })) },
        },
        include: { seats: true },
      })
    })
  } catch (err) {
    // Whatever went wrong, don't leave the seats locked in Redis for 5
    // minutes — nobody holds a booking for them.
    await releaseSeatHolds(input.seatIds)
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new SeatUnavailableError()
    }
    throw err
  }
}

// Returns seats to the pool for bookings that were never paid for.
//
// ponytail: swept lazily from read paths rather than by a scheduled worker —
// no extra process, and a seat only needs to look free at the moment someone
// looks. If seats must free themselves on time even with nobody watching,
// promote this to a cron job.
export async function expireStaleBookings(): Promise<number> {
  return await prisma.$transaction(async (tx) => {
    const stale = await tx.booking.findMany({
      where: { status: 'PENDING_PAYMENT', expiresAt: { lt: new Date() } },
      select: { id: true, seats: { select: { seatId: true } } },
    })
    if (stale.length === 0) return 0

    const seatIds = stale.flatMap((b) => b.seats.map((s) => s.seatId))

    // Both updates in one transaction. Split them and a crash in between
    // leaves the booking expired while its seats stay BOOKED forever.
    await tx.seat.updateMany({ where: { id: { in: seatIds } }, data: { status: 'AVAILABLE' } })
    await tx.booking.updateMany({
      where: { id: { in: stale.map((b) => b.id) } },
      data: { status: 'EXPIRED' },
    })
    return stale.length
  })
}

// Scoped by userId so a caller can only ever read their own booking. The
// route turns a null into 404 rather than 403, so ids can't be probed.
export async function getBookingForUser(bookingId: string, userId: string) {
  return await prisma.booking.findFirst({
    where: { id: bookingId, userId },
    include: {
      showtime: { include: { event: { include: { venue: true } } } },
      seats: { include: { seat: { include: { seatMap: true } } } },
    },
  })
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/booking.ts tests/unit/api/booking.test.ts
git commit -m "feat(api): add booking creation with row-locked seat reservation"
```

---

### Task 6: Seat-map library and the two new route modules

**Files:**
- Create: `apps/api/src/lib/seats.ts`
- Create: `apps/api/src/routes/showtimes.ts`
- Create: `apps/api/src/routes/bookings.ts`
- Modify: `apps/api/src/index.ts`
- Test: `tests/unit/api/seats.test.ts`

**Interfaces:**
- Produces: `getSeatMap(showtimeId: string)` returning `{ zones: [{ zoneName, price, seats: [{ id, row, number, status }] }] }` where `status` is `'AVAILABLE' | 'HELD' | 'BOOKED'`.
- Produces routes: `GET /showtimes/:id/seats`, `POST /showtimes/:id/seats/hold`, `GET /bookings/:id`.

- [ ] **Step 1: Write the failing test — `tests/unit/api/seats.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetHeld = vi.fn()
vi.mock('../../../apps/api/src/lib/seat-lock', () => ({ getHeldSeatIds: mockGetHeld }))

const mockExpire = vi.fn()
vi.mock('../../../apps/api/src/lib/booking', () => ({ expireStaleBookings: mockExpire }))

const mockFindMany = vi.fn()
vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: { seatMap: { findMany: mockFindMany } },
}))

import { getSeatMap } from '../../../apps/api/src/lib/seats'

beforeEach(() => {
  vi.clearAllMocks()
  mockExpire.mockResolvedValue(0)
  mockGetHeld.mockResolvedValue(new Set())
})

describe('getSeatMap', () => {
  it('marks a seat HELD when Redis holds it, without changing the DB', async () => {
    mockFindMany.mockResolvedValue([
      {
        zoneName: 'VIP',
        price: 3500,
        seats: [
          { id: 's1', row: 'A', number: 1, status: 'AVAILABLE' },
          { id: 's2', row: 'A', number: 2, status: 'AVAILABLE' },
        ],
      },
    ])
    mockGetHeld.mockResolvedValue(new Set(['s2']))

    const result = await getSeatMap('st1')

    expect(result.zones[0].seats).toEqual([
      { id: 's1', row: 'A', number: 1, status: 'AVAILABLE' },
      { id: 's2', row: 'A', number: 2, status: 'HELD' },
    ])
  })

  it('leaves a BOOKED seat BOOKED even if a stale hold exists', async () => {
    mockFindMany.mockResolvedValue([
      { zoneName: 'VIP', price: 3500, seats: [{ id: 's1', row: 'A', number: 1, status: 'BOOKED' }] },
    ])
    mockGetHeld.mockResolvedValue(new Set(['s1']))

    const result = await getSeatMap('st1')

    expect(result.zones[0].seats[0].status).toBe('BOOKED')
  })

  it('expires stale bookings first so freed seats show as available', async () => {
    mockFindMany.mockResolvedValue([])

    await getSeatMap('st1')

    expect(mockExpire).toHaveBeenCalled()
    expect(mockExpire.mock.invocationCallOrder[0]).toBeLessThan(
      mockFindMany.mock.invocationCallOrder[0],
    )
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/api && npx vitest run`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `apps/api/src/lib/seats.ts`**

```ts
import { prisma } from './prisma.js'
import { getHeldSeatIds } from './seat-lock.js'
import { expireStaleBookings } from './booking.js'

export async function getSeatMap(showtimeId: string) {
  // Sweep first: a seat freed by an expired booking must not still read as
  // BOOKED to the person looking at the map right now.
  await expireStaleBookings()

  const zones = await prisma.seatMap.findMany({
    where: { showtimeId },
    orderBy: { price: 'desc' },
    select: {
      zoneName: true,
      price: true,
      seats: {
        orderBy: [{ row: 'asc' }, { number: 'asc' }],
        select: { id: true, row: true, number: true, status: true },
      },
    },
  })

  const allSeatIds = zones.flatMap((z) => z.seats.map((s) => s.id))
  const heldIds = await getHeldSeatIds(allSeatIds)

  return {
    zones: zones.map((zone) => ({
      zoneName: zone.zoneName,
      price: zone.price,
      seats: zone.seats.map((seat) => ({
        id: seat.id,
        row: seat.row,
        number: seat.number,
        // BOOKED wins: it is permanent, a hold is not.
        status: seat.status === 'BOOKED' ? 'BOOKED' : heldIds.has(seat.id) ? 'HELD' : 'AVAILABLE',
      })),
    })),
  }
}
```

- [ ] **Step 4: Create `apps/api/src/routes/showtimes.ts`**

```ts
import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { getSeatMap } from '../lib/seats.js'
import { createBooking, SeatUnavailableError, TooManySeatsError } from '../lib/booking.js'
import { requireAuth } from '../middleware/auth.js'
import { logServerError } from '../lib/log.js'
import { MAX_SEATS_PER_BOOKING } from '../lib/config.js'

const router = Router()

export const getSeatsHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' })

  try {
    return res.json(await getSeatMap(id))
  } catch (err) {
    logServerError('GET /showtimes/:id/seats failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

router.get('/:id/seats', getSeatsHandler)

const holdSchema = z.object({
  seatIds: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_SEATS_PER_BOOKING)
    // Duplicates would double-count the price and try to lock one seat twice.
    .refine((ids) => new Set(ids).size === ids.length, { message: 'seatIds must be unique' }),
})

export const holdSeatsHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' })

  const parsed = holdSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const booking = await createBooking({ userId, showtimeId: id, seatIds: parsed.data.seatIds })
    return res.status(201).json({
      booking: {
        id: booking.id,
        status: booking.status,
        totalPrice: booking.totalPrice,
        expiresAt: booking.expiresAt,
      },
    })
  } catch (err) {
    if (err instanceof TooManySeatsError) {
      return res.status(400).json({ error: `A booking may hold at most ${MAX_SEATS_PER_BOOKING} seats` })
    }
    if (err instanceof SeatUnavailableError) {
      return res.status(409).json({ error: 'One or more seats are no longer available' })
    }
    logServerError('POST /showtimes/:id/seats/hold failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

router.post('/:id/seats/hold', requireAuth, holdSeatsHandler)

export default router
```

- [ ] **Step 5: Create `apps/api/src/routes/bookings.ts`**

```ts
import { Router, type RequestHandler } from 'express'
import { getBookingForUser } from '../lib/booking.js'
import { requireAuth } from '../middleware/auth.js'
import { logServerError } from '../lib/log.js'

const router = Router()

export const getBookingHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' })

  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const booking = await getBookingForUser(id, userId)
    // 404 rather than 403 for someone else's booking: a 403 would confirm the
    // id exists, letting a caller enumerate bookings.
    if (!booking) return res.status(404).json({ error: 'Booking not found' })
    return res.json({ booking })
  } catch (err) {
    logServerError('GET /bookings/:id failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

router.get('/:id', requireAuth, getBookingHandler)

export default router
```

- [ ] **Step 6: Mount both routers in `apps/api/src/index.ts`**

Add the imports beside the existing route imports, and the mounts beside the existing `app.use` calls:

```ts
import showtimesRouter from './routes/showtimes.js'
import bookingsRouter from './routes/bookings.js'
// ...
app.use('/showtimes', showtimesRouter)
app.use('/bookings', bookingsRouter)
```

- [ ] **Step 7: Run tests and typecheck**

Run: `cd apps/api && npx vitest run && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 8: Manual smoke against the running stack**

Run (Postgres and Redis up, seed applied):
```bash
docker compose up -d postgres redis
cd apps/api && npx tsx src/index.ts &
sleep 3
SHOWTIME=$(curl -s http://localhost:4000/events | python3 -c "import sys,json;print(json.load(sys.stdin)['events'][0]['showtimes'][0]['id'])")
curl -s "http://localhost:4000/showtimes/$SHOWTIME/seats" | python3 -c "import sys,json;d=json.load(sys.stdin);print([ (z['zoneName'], z['price'], len(z['seats'])) for z in d['zones']])"
curl -s -o /dev/null -w 'hold without login -> %{http_code}\n' -X POST "http://localhost:4000/showtimes/$SHOWTIME/seats/hold" -H 'Content-Type: application/json' -d '{"seatIds":["x"]}'
kill %1
```
Expected: three zones with 30 seats each, and `401` for the unauthenticated hold.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/lib/seats.ts apps/api/src/routes/showtimes.ts apps/api/src/routes/bookings.ts apps/api/src/index.ts tests/unit/api/seats.test.ts
git commit -m "feat(api): add seat map and booking endpoints"
```

---

### Task 7: Concurrency test — the proof the phase exists for

**Files:**
- Create: `tests/integration/seat-concurrency.test.ts`
- Create: `apps/api/vitest.integration.config.ts`
- Modify: `apps/api/package.json` (add `test:integration` script)

**Interfaces:** none — this task only proves behavior.

This test needs real Postgres and real Redis. It is deliberately kept out of the default `npm test` run so the unit suite stays dependency-free.

- [ ] **Step 1: Create `apps/api/vitest.integration.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['../../tests/integration/**/*.test.ts'],
    // Real DB round trips plus a deliberate burst; the default 5s is tight.
    testTimeout: 30_000,
    // These tests share one database — running files in parallel would let
    // them clobber each other's seats.
    fileParallelism: false,
  },
})
```

- [ ] **Step 2: Add the script to `apps/api/package.json`**

```json
"test:integration": "vitest run --config vitest.integration.config.ts"
```

- [ ] **Step 3: Write `tests/integration/seat-concurrency.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../../apps/api/src/lib/prisma'
import { closeRedis, getRedis } from '../../apps/api/src/lib/redis'
import { createBooking, SeatUnavailableError } from '../../apps/api/src/lib/booking'

let seatIds: string[] = []
let showtimeId = ''
const userIds: string[] = []

beforeAll(async () => {
  const seatMap = await prisma.seatMap.findFirst({
    include: { seats: { take: 2, orderBy: { id: 'asc' } }, showtime: true },
  })
  if (!seatMap) throw new Error('No seat maps found — run `npx prisma db seed` first')

  showtimeId = seatMap.showtimeId
  seatIds = seatMap.seats.map((s) => s.id)

  // Reset the seats this test uses, so a rerun starts clean.
  await prisma.bookingSeat.deleteMany({ where: { seatId: { in: seatIds } } })
  await prisma.seat.updateMany({ where: { id: { in: seatIds } }, data: { status: 'AVAILABLE' } })
  const redis = await getRedis()
  await redis.del(seatIds.map((id) => `hold:seat:${id}`))

  for (let i = 0; i < 20; i++) {
    const user = await prisma.user.create({
      data: {
        email: `concurrency-${i}-${Date.now()}@example.com`,
        passwordHash: 'x',
        name: `Tester ${i}`,
      },
    })
    userIds.push(user.id)
  }
})

afterAll(async () => {
  await prisma.bookingSeat.deleteMany({ where: { seatId: { in: seatIds } } })
  await prisma.booking.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.seat.updateMany({ where: { id: { in: seatIds } }, data: { status: 'AVAILABLE' } })
  await closeRedis()
  await prisma.$disconnect()
})

describe('two people clicking the same seat at the same time', () => {
  it('produces exactly one booking, however many fire at once', async () => {
    const seatId = seatIds[0]

    // Promise.all, not a loop with await: a sequential loop passes even when
    // the code has a check-then-act race, which is exactly how such a bug
    // reaches production.
    const results = await Promise.allSettled(
      userIds.map((userId) => createBooking({ userId, showtimeId, seatIds: [seatId] })),
    )

    const succeeded = results.filter((r) => r.status === 'fulfilled')
    const failed = results.filter((r) => r.status === 'rejected')

    expect(succeeded).toHaveLength(1)
    expect(failed).toHaveLength(userIds.length - 1)
    for (const f of failed) {
      expect((f as PromiseRejectedResult).reason).toBeInstanceOf(SeatUnavailableError)
    }

    // The database must agree, not just the return values.
    const rows = await prisma.bookingSeat.findMany({ where: { seatId } })
    expect(rows).toHaveLength(1)

    const seat = await prisma.seat.findUniqueOrThrow({ where: { id: seatId } })
    expect(seat.status).toBe('BOOKED')
  })
})
```

- [ ] **Step 4: Run it against the real stack**

Run:
```bash
docker compose up -d postgres redis
cd apps/api && npx prisma db seed && npm run test:integration
```
Expected: the test passes — 1 fulfilled, 19 rejected, exactly one `BookingSeat` row.

**If it fails with more than one success, stop.** That is the double-booking bug this phase exists to prevent; report it rather than weakening the test.

- [ ] **Step 5: Confirm the unit suite still runs without Redis or Postgres**

Run: `docker compose stop redis postgres && cd apps/api && npx vitest run && docker compose start redis postgres`
Expected: the unit suite still passes — it mocks both.

- [ ] **Step 6: Commit**

```bash
git add tests/integration apps/api/vitest.integration.config.ts apps/api/package.json
git commit -m "test(api): prove concurrent seat booking yields exactly one winner"
```

---

### Task 8: Seat map page

**Files:**
- Create: `apps/web/app/showtimes/[id]/seats/page.tsx`
- Create: `apps/web/app/showtimes/[id]/seats/seat-picker.tsx`
- Modify: `apps/web/app/events/[id]/page.tsx`

**Interfaces:**
- Consumes: `GET /showtimes/:id/seats`, `POST /showtimes/:id/seats/hold` via `apiFetch` from `@/lib/api`.

The page is a server component that fetches the map; the interactive picker is a small client component. Splitting them keeps the data fetch on the server and ships only the selection logic to the browser.

- [ ] **Step 1: Create `apps/web/app/showtimes/[id]/seats/seat-picker.tsx`**

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api'

type Seat = { id: string; row: string; number: number; status: 'AVAILABLE' | 'HELD' | 'BOOKED' }
type Zone = { zoneName: string; price: number; seats: Seat[] }

const MAX_SEATS = 8

// Status is never conveyed by colour alone — each state also carries a symbol
// and a text label, so it stays readable for colour-blind users.
const SEAT_STYLE: Record<Seat['status'], { className: string; symbol: string; label: string }> = {
  AVAILABLE: { className: 'bg-white border-gray-400 hover:border-black', symbol: '', label: 'ว่าง' },
  HELD: { className: 'bg-yellow-100 border-yellow-500 text-yellow-800 cursor-not-allowed', symbol: '⏳', label: 'มีคนกำลังจอง' },
  BOOKED: { className: 'bg-gray-300 border-gray-400 text-gray-500 cursor-not-allowed', symbol: '✕', label: 'ถูกจองแล้ว' },
}

export function SeatPicker({ showtimeId, zones }: { showtimeId: string; zones: Zone[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const priceOf = (seatId: string) =>
    zones.find((z) => z.seats.some((s) => s.id === seatId))?.price ?? 0
  // Display only — the server recomputes the real total from the database.
  const total = [...selected].reduce((sum, id) => sum + priceOf(id), 0)

  function toggle(seat: Seat) {
    if (seat.status !== 'AVAILABLE') return
    setError(null)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(seat.id)) next.delete(seat.id)
      else if (next.size >= MAX_SEATS) return prev
      else next.add(seat.id)
      return next
    })
  }

  async function handleSubmit() {
    if (selected.size === 0 || submitting) return
    setSubmitting(true)
    setError(null)

    let res: Response
    try {
      res = await apiFetch(`/showtimes/${showtimeId}/seats/hold`, {
        method: 'POST',
        body: JSON.stringify({ seatIds: [...selected] }),
      })
    } catch (err) {
      console.error(err)
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
      setSubmitting(false)
      return
    }

    if (res.status === 401) {
      router.push('/login')
      return
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(
        typeof data.error === 'string'
          ? 'ที่นั่งบางที่ถูกจองไปแล้ว กรุณาเลือกใหม่'
          : 'จองไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
      )
      setSubmitting(false)
      router.refresh()
      return
    }

    const data = await res.json()
    router.push(`/bookings/${data.booking.id}`)
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-red-600">{error}</p>}

      <ul className="flex flex-wrap gap-4 text-sm">
        {(Object.keys(SEAT_STYLE) as Seat['status'][]).map((status) => (
          <li key={status} className="flex items-center gap-2">
            <span className={`inline-block h-5 w-5 rounded border ${SEAT_STYLE[status].className}`} />
            {SEAT_STYLE[status].label}
          </li>
        ))}
      </ul>

      {zones.map((zone) => (
        <section key={zone.zoneName}>
          <h2 className="font-semibold mb-2">
            {zone.zoneName} — {zone.price.toLocaleString('th-TH')} บาท
          </h2>
          <div className="flex flex-col gap-1">
            {Object.entries(
              zone.seats.reduce<Record<string, Seat[]>>((rows, seat) => {
                ;(rows[seat.row] ??= []).push(seat)
                return rows
              }, {}),
            ).map(([row, seats]) => (
              <div key={row} className="flex items-center gap-1">
                <span className="w-5 text-sm text-gray-500">{row}</span>
                {seats.map((seat) => {
                  const isSelected = selected.has(seat.id)
                  const style = SEAT_STYLE[seat.status]
                  return (
                    <button
                      key={seat.id}
                      type="button"
                      onClick={() => toggle(seat)}
                      disabled={seat.status !== 'AVAILABLE'}
                      aria-pressed={isSelected}
                      aria-label={`แถว ${seat.row} ที่ ${seat.number} — ${isSelected ? 'เลือกแล้ว' : style.label}`}
                      className={`h-11 w-11 rounded border text-xs ${
                        isSelected ? 'bg-black text-white border-black' : style.className
                      }`}
                    >
                      {isSelected ? '✓' : (style.symbol || seat.number)}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </section>
      ))}

      <div className="sticky bottom-0 bg-white border-t py-3 flex items-center justify-between">
        <p>
          เลือก {selected.size} ที่ · รวม {total.toLocaleString('th-TH')} บาท
        </p>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={selected.size === 0 || submitting}
          className="bg-black text-white px-4 py-2 rounded disabled:bg-gray-400"
        >
          {submitting ? 'กำลังจอง…' : 'จองที่นั่ง'}
        </button>
      </div>
    </div>
  )
}
```

The seat buttons are `h-11 w-11` (44px), the minimum comfortable touch target named in the plan's non-functional requirements.

- [ ] **Step 2: Create `apps/web/app/showtimes/[id]/seats/page.tsx`**

```tsx
import { API_URL } from '@/lib/api'
import { SeatPicker } from './seat-picker'

type Zone = {
  zoneName: string
  price: number
  seats: { id: string; row: string; number: number; status: 'AVAILABLE' | 'HELD' | 'BOOKED' }[]
}

async function fetchSeatMap(showtimeId: string): Promise<Zone[] | null> {
  try {
    const res = await fetch(`${API_URL}/showtimes/${showtimeId}/seats`, { cache: 'no-store' })
    if (!res.ok) return null
    const data = await res.json()
    return Array.isArray(data.zones) ? data.zones : null
  } catch (err) {
    console.error(err)
    return null
  }
}

export default async function SeatsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const zones = await fetchSeatMap(id)

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-bold mb-4">เลือกที่นั่ง</h1>
      {zones === null ? (
        <p className="text-red-600">โหลดผังที่นั่งไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</p>
      ) : zones.length === 0 ? (
        <p className="text-gray-500">รอบนี้ยังไม่มีผังที่นั่ง</p>
      ) : (
        <SeatPicker showtimeId={id} zones={zones} />
      )}
    </main>
  )
}
```

- [ ] **Step 3: Link showtimes to the seat page in `apps/web/app/events/[id]/page.tsx`**

Wrap each showtime `<li>`'s content in a link. Replace the existing showtime list item body with:

```tsx
<Link href={`/showtimes/${showtime.id}/seats`} className="underline">
  {new Date(showtime.startTime).toLocaleString('th-TH')} —{' '}
  {new Date(showtime.endTime).toLocaleString('th-TH')} ({showtime.status})
</Link>
```

Add `import Link from 'next/link'` at the top if it is not already imported.

- [ ] **Step 4: Verify**

Run: `cd apps/web && npx next build && npx tsc --noEmit`
Expected: build succeeds and `/showtimes/[id]/seats` appears in the route list.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/showtimes apps/web/app/events/\[id\]/page.tsx
git commit -m "feat(web): add seat map page with accessible seat picker"
```

---

### Task 9: Booking status page

**Files:**
- Create: `apps/web/app/bookings/[id]/page.tsx`
- Create: `apps/web/app/bookings/[id]/countdown.tsx`

**Interfaces:**
- Consumes: `GET /bookings/:id` — which requires the auth cookie, so this page fetches from the **client** via `apiFetch`, not from the server. A server component's `fetch` would not carry the browser's httpOnly cookie.

- [ ] **Step 1: Create `apps/web/app/bookings/[id]/countdown.tsx`**

```tsx
'use client'

import { useEffect, useState } from 'react'

export function Countdown({ expiresAt }: { expiresAt: string }) {
  const [remaining, setRemaining] = useState(() => Date.parse(expiresAt) - Date.now())

  useEffect(() => {
    const timer = setInterval(() => setRemaining(Date.parse(expiresAt) - Date.now()), 1000)
    return () => clearInterval(timer)
  }, [expiresAt])

  if (remaining <= 0) return <span className="text-red-600">หมดเวลาแล้ว</span>

  const minutes = Math.floor(remaining / 60000)
  const seconds = Math.floor((remaining % 60000) / 1000)
  return (
    <span className="font-mono">
      {minutes}:{String(seconds).padStart(2, '0')}
    </span>
  )
}
```

- [ ] **Step 2: Create `apps/web/app/bookings/[id]/page.tsx`**

```tsx
'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import { Countdown } from './countdown'

type Booking = {
  id: string
  status: string
  totalPrice: number
  expiresAt: string
  showtime: { startTime: string; event: { title: string; venue: { name: string } } }
  seats: { seat: { row: string; number: number; seatMap: { zoneName: string } } }[]
}

export default function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [booking, setBooking] = useState<Booking | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let res: Response
      try {
        res = await apiFetch(`/bookings/${id}`)
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
        setError('ไม่พบการจองนี้')
        return
      }
      const data = await res.json()
      setBooking(data.booking)
    })()
    return () => {
      cancelled = true
    }
  }, [id, router])

  if (error) return <main className="mx-auto max-w-2xl p-8"><p className="text-red-600">{error}</p></main>
  if (!booking) return <main className="mx-auto max-w-2xl p-8"><p>กำลังโหลด…</p></main>

  return (
    <main className="mx-auto max-w-2xl p-8 flex flex-col gap-4">
      <h1 className="text-2xl font-bold">รายละเอียดการจอง</h1>

      <div className="border rounded p-4 flex flex-col gap-2">
        <p className="font-semibold">{booking.showtime.event.title}</p>
        <p className="text-gray-600">{booking.showtime.event.venue.name}</p>
        <p>รอบ {new Date(booking.showtime.startTime).toLocaleString('th-TH')}</p>
        <p>
          ที่นั่ง:{' '}
          {booking.seats
            .map((s) => `${s.seat.seatMap.zoneName} ${s.seat.row}${s.seat.number}`)
            .join(', ')}
        </p>
        <p>รวม {booking.totalPrice.toLocaleString('th-TH')} บาท</p>
        <p>สถานะ: {booking.status}</p>
        {booking.status === 'PENDING_PAYMENT' && (
          <p>
            เหลือเวลาชำระเงิน <Countdown expiresAt={booking.expiresAt} />
          </p>
        )}
      </div>

      <p className="text-sm text-gray-500">
        การชำระเงินจะเปิดให้ใช้งานใน Phase ถัดไป
      </p>
    </main>
  )
}
```

- [ ] **Step 3: Verify**

Run: `cd apps/web && npx next build && npx tsc --noEmit`
Expected: build succeeds and `/bookings/[id]` appears in the route list.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/bookings
git commit -m "feat(web): add booking status page with hold countdown"
```

---

### Task 10: Full verification pass

**Files:** none — verification only.

- [ ] **Step 1: Root build**

Run: `npm run build`
Expected: both workspaces build with no type errors; the route list includes `/showtimes/[id]/seats` and `/bookings/[id]`.

- [ ] **Step 2: Unit suite (no services running)**

Run: `npm test`
Expected: every unit test passes with pristine output.

- [ ] **Step 3: Integration suite (services running)**

Run:
```bash
docker compose up -d postgres redis
cd apps/api && npx prisma db seed && npm run test:integration
```
Expected: the concurrency test passes.

- [ ] **Step 4: Manual click-through**

With both dev servers up (`npm run dev:api`, `npm run dev:web`) and seeded data, in a browser:
1. Log in.
2. Open an event, click a showtime → the seat map renders with three zones.
3. Select two seats → the running total matches the zone prices.
4. Click จองที่นั่ง → redirected to `/bookings/<id>` showing both seats and a counting-down timer.
5. Open the same showtime in a second tab → those two seats now render as ถูกจองแล้ว.
6. Open `/bookings/<id>` while logged out (or as another user) → 404, not the booking.

- [ ] **Step 5: Report**

Summarize: what was built, what was deliberately skipped (Playwright e2e, payment), and anything a human should review before Phase 3.

---

## End-of-phase notes

- Playwright e2e is deliberately deferred to Phase 3, when the pay-and-get-ticket flow makes an end-to-end browser test worth its setup cost. The concurrency test covers the checklist item that actually distinguishes a correct implementation.
- `expireStaleBookings` runs lazily from read paths. If seats must free themselves with nobody watching, promote it to a scheduled job.
- The Redis hold and the Postgres row lock are deliberately redundant. The hold exists for a fast, friendly rejection; the row lock is what makes double-booking impossible.
