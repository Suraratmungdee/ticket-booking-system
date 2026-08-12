# Debt Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three debts the Phase 5 and Phase 6 whole-branch reviews recorded but deferred: an admin write that races the booking path, a missing uniqueness constraint that lets duplicate zones accumulate, and two list endpoints that silently hide rows past 100.

**Architecture:** All three are small and independent. The showtime fix follows the pattern that closed the same class of bug in `applyPaymentOutcome` — take the row lock first, decide from the locked value. The zone constraint is one additive migration. Pagination is a cursor on two existing queries.

**Source of the findings:** the Phase 5 final review (`updateShowtime` and the zone constraint) and the standing `// LIMITATION:` comments on both list functions.

**Tech Stack:** Express 5 + TypeScript (ESM/NodeNext), Prisma v6, PostgreSQL, Vitest. **No new dependencies.**

## Global Constraints

- **No new npm dependencies.**
- All business constants live in `apps/api/src/lib/config.ts` with a comment explaining the number.
- `apps/api/src` is ESM/NodeNext — **every relative import needs a `.js` extension**. Files under `tests/` must NOT have them.
- Routes stay thin adapters; logic lives in `apps/api/src/lib`.
- Not-authorised returns `404`, never `403`. Admin routes carry both `requireAuth` and `requireAdmin`.
- Every mutation writes its audit entry via `recordAudit(tx, …)` **inside the same transaction**, using the transaction client — never the global `prisma` import, which type-checks silently because `PrismaClient` is a structural superset of `Prisma.TransactionClient`.
- **Migrations are additive.** No `DROP`. If the generated SQL contains one, stop and report.
- **Never `deleteMany` without a `where` scoped to rows the test created.** The dev Postgres is shared with other git worktrees. Never stop or restart the shared containers.
- Deliberate corner-cuts carry a `// LIMITATION:` or `// ponytail:` comment naming the ceiling.
- **Never write a comment that overstates what the code or a test delivers.** This project has shipped that mistake three times; each was caught only by a reviewer reverting the code and watching the suite stay green.
- **Current baseline: `npm run build` clean, `npm test` = 182 unit tests across 23 files, `cd apps/api && npm run test:integration` = 10 tests.** All must keep passing.

**Branch note:** this branches off `phase6-hardening`, which is not yet merged to `main`. Phase 6 must merge first.

---

### Task 1: Lock the Showtime row before writing its start time

**Files:**
- Modify: `apps/api/src/lib/admin.ts`
- Test: `tests/unit/api/admin-seatmap.test.ts` (extend — it already covers `createShowtime`)

**Interfaces:**
- Consumes: `recordAudit` from `apps/api/src/lib/audit.js`.
- Produces: `updateShowtime` keeps its signature `(adminId: string, id: string, input: { startTime?: Date; endTime?: Date })`.

**The defect.** `createBooking` (in `apps/api/src/lib/booking.ts`) reads `Showtime.startTime` and `Showtime.status` inside a query that locks **only the `Seat` rows** — its `FOR UPDATE OF s` names the seat alias alone, so the joined `Showtime` row is read without a lock. `updateShowtime` writes `startTime` with no lock at all. A booking transaction can therefore read a future `startTime`, pass its "showtime has not started" gate, and commit while an admin moves that showtime into the past.

This is the same shape the project deliberately avoided by refusing to let anything write `Showtime.status` — the reasoning applies to `startTime` equally, and the Phase 5 review flagged that the rule was written too narrowly.

Read `apps/api/src/lib/booking.ts` in full before starting, and read `applyPaymentOutcome` in `apps/api/src/lib/payment.ts` — it closes the identical class of bug by taking `SELECT … FOR UPDATE` on the Booking row and branching on the locked value. Follow that precedent.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/api/admin-seatmap.test.ts`, inside its existing `describe` for showtimes or in a new one. Add `showtimeQueryRaw: vi.fn()` to the file's `vi.hoisted` object `m`, and add `$queryRaw: m.showtimeQueryRaw` to the transaction stub that `txRuns()` builds.

```ts
describe('updateShowtime', () => {
  it('locks the showtime row before writing, so a concurrent booking cannot read a stale start time', async () => {
    m.showtimeQueryRaw.mockResolvedValue([{ id: 'st1' }])
    m.showtimeUpdate.mockResolvedValue({ id: 'st1' })

    await updateShowtime('admin-1', 'st1', {
      startTime: new Date('2026-09-02T12:00:00Z'),
    })

    // The lock must be taken, and taken before the write — createBooking
    // reads startTime under a lock that covers only the Seat rows, so this
    // row lock is the only thing serialising the two.
    expect(m.showtimeQueryRaw).toHaveBeenCalledTimes(1)
    expect(m.showtimeQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      m.showtimeUpdate.mock.invocationCallOrder[0],
    )
  })

  it('404s rather than writing when the showtime does not exist', async () => {
    m.showtimeQueryRaw.mockResolvedValue([])

    await expect(
      updateShowtime('admin-1', 'missing', { startTime: new Date('2026-09-02T12:00:00Z') }),
    ).rejects.toThrow()

    expect(m.showtimeUpdate).not.toHaveBeenCalled()
    expect(m.auditCreate).not.toHaveBeenCalled()
  })
})
```

Import `updateShowtime` alongside the other imports from `lib/admin`.

- [ ] **Step 2: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/admin-seatmap.test.ts`
Expected: FAIL — `$queryRaw` never called.

- [ ] **Step 3: Take the lock in `apps/api/src/lib/admin.ts`**

Replace `updateShowtime` with:

```ts
export async function updateShowtime(
  adminId: string,
  id: string,
  input: { startTime?: Date; endTime?: Date },
) {
  return prisma.$transaction(async (tx) => {
    // createBooking reads Showtime.startTime and Showtime.status inside a
    // query whose FOR UPDATE names only the Seat rows (`FOR UPDATE OF s`),
    // so the Showtime row it joins is read unlocked. Without this lock, a
    // booking transaction can read a future startTime, pass its
    // "showtime has not started" gate, and commit while this write moves the
    // showtime into the past — a booking for a show that already began.
    //
    // Taking the lock here serialises the two: a booking holding the seat
    // rows blocks this write, and this write blocks a booking that has not
    // yet read the showtime. Lock order is Showtime -> Seat here and in
    // createBooking, which is also compatible with applyPaymentOutcome's
    // Booking -> Payment -> Seat, so no cycle exists.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Showtime" WHERE id = ${id} FOR UPDATE
    `
    if (locked.length === 0) {
      // Matches what Prisma's update would have thrown, so the route's
      // existing P2025 -> 404 mapping keeps working unchanged.
      throw Object.assign(new Error('Showtime not found'), { code: 'P2025' })
    }

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
```

**Check the route's error mapping still works.** Read `apps/api/src/routes/admin.ts`'s `updateShowtimeHandler` and confirm the thrown object still lands in its `P2025 → 404` branch. If it does not, fix the mapping rather than weakening the throw.

- [ ] **Step 4: Add the matching lock to `createBooking`**

`apps/api/src/lib/booking.ts` reads the showtime through the seat query. Extend that query's lock to cover the showtime row as well, keeping the existing `ORDER BY s.id` (the global lock order that prevents seat-vs-seat deadlock):

Change `FOR UPDATE OF s` to `FOR UPDATE OF s, t`.

Add a comment saying why: the showtime's `status` and `startTime` are both read from this row and both are decision inputs, so reading them unlocked is a check-then-act race against `updateShowtime`.

**Verify the lock ordering claim before you write it.** `updateShowtime` locks Showtime then writes it; `createBooking` locks Seat and Showtime in one statement. Postgres acquires row locks within a single statement in the order rows are produced. State in your report whether a deadlock is possible between these two and why — do not assert "no deadlock" without reasoning it through.

- [ ] **Step 5: Run the full suite**

Run: `npm test && cd apps/api && npm run test:integration`
Expected: PASS — 184 unit tests, 10 integration tests. Check `docker info` first; never stop the shared containers.

- [ ] **Step 6: Prove the lock is load-bearing**

Remove the `SELECT … FOR UPDATE` from `updateShowtime` and re-run the unit test — the ordering assertion must fail. Restore it. Record both runs in your report.

Then state honestly whether any test proves the *concurrency* property rather than merely that the statement is issued. A unit test with a mocked transaction cannot; say so rather than implying coverage.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/admin.ts apps/api/src/lib/booking.ts tests/unit/api/admin-seatmap.test.ts
git commit -m "fix(api): lock the Showtime row when changing its start time"
```

---

### Task 2: One zone name per showtime

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/routes/admin.ts`
- Test: `tests/unit/api/admin-seatmap.test.ts`

**Interfaces:**
- Produces: `@@unique([showtimeId, zoneName])` on `SeatMap`; a `409` on the duplicate path.

**The defect.** Nothing stops `POST /admin/seatmaps` creating two zones called "VIP" on one showtime. `MAX_SEATS_PER_SEATMAP` caps a single zone, not a showtime, so repeated posts also grow the total seat count without bound behind an unpaginated seat-map endpoint.

- [ ] **Step 1: Add the constraint to `apps/api/prisma/schema.prisma`**

On the existing `SeatMap` model, leaving every field unchanged:

```prisma
  // One zone name per showtime. Without this, a repeated POST silently
  // creates a second "VIP" zone rather than failing, and the per-zone seat
  // cap stops bounding the showtime's total.
  @@unique([showtimeId, zoneName])
```

- [ ] **Step 2: Create the migration**

```bash
cd apps/api && npx prisma migrate dev --name unique_zone_per_showtime
```

**Open the generated SQL.** It must contain only `CREATE UNIQUE INDEX`. If it contains any `DROP`, stop and report.

**This migration can fail** if the shared dev database already holds duplicate zones from earlier manual testing. If it does, **do not delete the duplicates** — `CLAUDE.md` §5 forbids deleting data. Report the exact rows and stop.

- [ ] **Step 3: Write the failing test**

Append to `tests/unit/api/admin-seatmap.test.ts`:

```ts
it('maps a duplicate zone name to 409 rather than a 500', async () => {
  m.seatMapCreate.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }))
  const res = makeRes()

  await createSeatMapHandler(
    {
      body: {
        showtimeId: 'st1',
        zoneName: 'VIP',
        price: 1500,
        rows: ['A'],
        seatsPerRow: 2,
      },
      user: { id: 'admin-1' },
    } as never,
    res,
    vi.fn(),
  )

  expect(res.status).toHaveBeenCalledWith(409)
})
```

Reuse the file's existing `makeRes` helper and route-handler import rather than adding new ones.

- [ ] **Step 4: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/admin-seatmap.test.ts`
Expected: FAIL — currently a 500.

- [ ] **Step 5: Map `P2002` to `409` in `apps/api/src/routes/admin.ts`**

In `createSeatMapHandler`'s catch, before the generic 500:

```ts
    // The unique index on (showtimeId, zoneName). A repeated submit is the
    // caller's mistake, not a server fault. Note this is a *mapping*, not a
    // swallow: the transaction has already aborted, and nothing continues
    // past it.
    if (isPrismaCode(err, 'P2002')) {
      return res.status(409).json({ error: 'That zone already exists for this showtime' })
    }
```

**Update the existing comment in that catch block** that explains why P2002 was previously left unhandled — it is now handled, and a stale comment claiming otherwise is exactly the failure mode this project keeps hitting.

- [ ] **Step 6: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS — 185 unit tests, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma apps/api/src/routes/admin.ts tests/unit/api/admin-seatmap.test.ts
git commit -m "feat(api): one zone name per showtime, duplicate returns 409"
```

---

### Task 3: Cursor pagination on the two admin lists

**Files:**
- Modify: `apps/api/src/lib/admin.ts`
- Modify: `apps/api/src/routes/admin.ts`
- Modify: `apps/web/app/admin/bookings/page.tsx`
- Test: `tests/unit/api/admin-reports.test.ts`

**Interfaces:**
- Produces: `listBookings(filters: { status?: string; email?: string; cursor?: string })` returning `{ bookings, nextCursor }`, where `nextCursor` is the id to pass next or `null` at the end.

**The defect.** `listBookings` and `listAllEvents` both take a hard 100 rows with a `// LIMITATION:` saying older rows become unreachable. For bookings that is a real hole: an admin investigating an old complaint cannot reach it.

**Scope: bookings only.** `listAllEvents` keeps its cap — a catalog of events is bounded by how many an operator creates, and its `LIMITATION` comment stays accurate. Say so in the comment rather than leaving a reader to wonder why one was fixed and not the other.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/api/admin-reports.test.ts`:

```ts
describe('listBookings pagination', () => {
  it('returns a nextCursor when a full page came back', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: `b${i}` }))
    m.bookingFindMany.mockResolvedValue(page)

    const result = await listBookings({})

    expect(result.bookings).toHaveLength(100)
    expect(result.nextCursor).toBe('b99')
  })

  it('returns a null cursor on a partial page, so the client stops', async () => {
    m.bookingFindMany.mockResolvedValue([{ id: 'b1' }])

    const result = await listBookings({})

    expect(result.nextCursor).toBeNull()
  })

  it('passes the cursor to Prisma and skips the cursor row itself', async () => {
    m.bookingFindMany.mockResolvedValue([])

    await listBookings({ cursor: 'b42' })

    const args = m.bookingFindMany.mock.calls[0][0]
    expect(args.cursor).toEqual({ id: 'b42' })
    // Without skip: 1 the cursor row is returned again on every page, so the
    // last row of page N reappears as the first row of page N+1.
    expect(args.skip).toBe(1)
  })

  it('keeps the filters applied when paginating', async () => {
    m.bookingFindMany.mockResolvedValue([])

    await listBookings({ status: 'PAID', cursor: 'b42' })

    expect(m.bookingFindMany.mock.calls[0][0].where).toEqual({ status: 'PAID' })
  })
})
```

**Note:** the existing tests in this file assert on `listBookings(...)`'s return value as an array. Changing the return shape to `{ bookings, nextCursor }` will break them. **Update those call sites to read `.bookings`, but do not weaken what they assert** — they check the `where`, `take` and ordering, all of which must still hold.

- [ ] **Step 2: Run it, expect failure**

Run: `cd apps/api && npx vitest run ../../tests/unit/api/admin-reports.test.ts`
Expected: FAIL — `nextCursor` undefined.

- [ ] **Step 3: Add the cursor to `listBookings` in `apps/api/src/lib/admin.ts`**

```ts
export async function listBookings(filters: {
  status?: string
  email?: string
  cursor?: string
}) {
  const bookings = await prisma.booking.findMany({
    where: {
      ...(filters.status ? { status: filters.status as never } : {}),
      ...(filters.email
        ? { user: { email: { contains: filters.email, mode: 'insensitive' as const } } }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: BOOKING_LIST_LIMIT,
    // skip: 1 steps past the cursor row itself; without it the last row of
    // one page reappears as the first row of the next.
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    include: {
      user: { select: { email: true, name: true } },
      showtime: { include: { event: { select: { title: true } } } },
      seats: { include: { seat: { select: { row: true, number: true } } } },
    },
  })

  // A full page means there may be more; a short page means there is not.
  // This can hand back one cursor that turns out to lead to an empty page
  // when the total is an exact multiple of the limit — a wasted request, not
  // a wrong answer.
  const nextCursor = bookings.length === BOOKING_LIST_LIMIT ? bookings[bookings.length - 1].id : null

  return { bookings, nextCursor }
}
```

Update `listAllEvents`'s `// LIMITATION:` comment to say the cap is deliberate there and why bookings got a cursor instead.

- [ ] **Step 4: Thread it through the route**

In `apps/api/src/routes/admin.ts`'s `listBookingsHandler`, read `cursor` from `req.query` the same guarded way `status` and `email` are read, pass it through, and return both fields:

```ts
    const { bookings, nextCursor } = await listBookings({
      status: typeof status === 'string' ? status : undefined,
      email: typeof email === 'string' ? email : undefined,
      cursor: typeof cursor === 'string' ? cursor : undefined,
    })
    return res.json({ bookings, nextCursor })
```

- [ ] **Step 5: Add a "load more" control to the bookings page**

In `apps/web/app/admin/bookings/page.tsx`, keep `nextCursor` in state, and render a button below the table when it is non-null that fetches the next page and **appends** to the list rather than replacing it. Changing a filter must reset both the list and the cursor — otherwise the new filter's first page lands underneath the old filter's rows.

Follow the page's existing `load()` / `cancelled` conventions exactly; do not introduce a second fetching pattern. All copy in Thai.

- [ ] **Step 6: Run everything**

Run: `npm test && npm run build`
Expected: PASS — 186 unit tests, no type errors in either workspace.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/admin.ts apps/api/src/routes/admin.ts apps/web/app/admin/bookings/page.tsx tests/unit/api/admin-reports.test.ts
git commit -m "feat: paginate the admin booking list"
```

---

## Definition of Done

1. `npm run build` clean in both workspaces.
2. `npm test` green — 186 unit tests — and `cd apps/api && npm run test:integration` green, 10 tests.
3. A summary of what changed, what was deliberately left, and what a human must review.

## Deliberately out of scope

| Skipped | Why |
|---|---|
| A cap on concurrent `PENDING_PAYMENT` bookings per user | A business rule that changes what a real user may do — `CLAUDE.md` §5 reserves it for a human, and the question is with them |
| Pagination on `listAllEvents` | The catalog is bounded by how many events an operator creates; its `LIMITATION` comment stays accurate |
| Backfilling a cancel-showtime endpoint now that the row is locked | Still cut by an explicit human decision |
