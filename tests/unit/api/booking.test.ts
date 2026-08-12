import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted, not plain consts: vi.mock factories are called when the module
// they mock is first imported, which Vitest hoists above ordinary top-level
// code (including plain `const` declarations) — a bare `const mockX =
// vi.fn()` referenced inside a factory would still be in its temporal dead
// zone at that point. vi.hoisted() is hoisted together with vi.mock so the
// values exist by the time the factory runs.
const { mockAcquire, mockRelease } = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
}))
vi.mock('../../../apps/api/src/lib/seat-lock', () => ({
  acquireSeatHolds: mockAcquire,
  releaseSeatHolds: mockRelease,
}))

const { mockQueryRaw, mockTransaction, mockBookingCreate, mockSeatUpdateMany, mockBookingFindFirst } = vi.hoisted(
  () => ({
    mockQueryRaw: vi.fn(),
    mockTransaction: vi.fn(),
    mockBookingCreate: vi.fn(),
    mockSeatUpdateMany: vi.fn(),
    mockBookingFindFirst: vi.fn(),
  }),
)
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
  expireStaleBookings,
  getBookingForUser,
  SeatUnavailableError,
  TooManySeatsError,
} from '../../../apps/api/src/lib/booking'

// A showtime state that passes the SCHEDULED-and-not-started check, so
// fixtures that only care about seat status don't also have to think about
// showtime timing.
const SCHEDULED = { showtimeStatus: 'SCHEDULED', showtimeStartTime: new Date(Date.now() + 3_600_000) }

// Runs the callback against a tx stub exposing the same shape the real
// transaction client does.
function txRuns(tx: Record<string, unknown>) {
  mockTransaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx))
}

// Same idea, but for createBooking specifically: createBooking now calls
// expireStaleBookings() (finding 2) before it opens its own seat-locking
// transaction, and expireStaleBookings *also* goes through
// prisma.$transaction — using the very same tx stub, since mockTransaction
// always hands back the one object passed in. Its first `$queryRaw` call is
// therefore the sweep, not the seat-lock query. This wrapper intercepts
// that first call and answers "no stale bookings" (`[]`), which makes
// expireStaleBookings short-circuit before it ever touches
// tx.bookingSeat/booking/seat — so createBooking tests only need to stub
// those for the seat-locking transaction, same as before this fix.
// (expireStaleBookings' own tests use plain `txRuns` above — they call
// expireStaleBookings() directly, with no preceding sweep to account for.)
function txRunsForCreateBooking(tx: Record<string, unknown>) {
  const mainQueryRaw = tx.$queryRaw as ((...args: unknown[]) => unknown) | undefined
  let sweepAnswered = false
  const composedQueryRaw = vi.fn(async (...args: unknown[]) => {
    if (!sweepAnswered) {
      sweepAnswered = true
      return []
    }
    return mainQueryRaw ? mainQueryRaw(...args) : []
  })
  mockTransaction.mockImplementation(async (fn: (t: unknown) => unknown) =>
    fn({ ...tx, $queryRaw: composedQueryRaw }),
  )
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

  it('rejects an empty seat list before touching Redis or the DB', async () => {
    await expect(createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: [] })).rejects.toThrow(
      TooManySeatsError,
    )

    expect(mockAcquire).not.toHaveBeenCalled()
    expect(mockTransaction).not.toHaveBeenCalled()
  })

  it('throws SeatUnavailableError when Redis says a seat is already held', async () => {
    mockAcquire.mockResolvedValue(false)

    await expect(
      createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: ['s1'] }),
    ).rejects.toThrow(SeatUnavailableError)

    // $transaction is called once — by expireStaleBookings' sweep, which
    // always runs first (finding 2). The seat-locking transaction (the one
    // that would create a booking) must never open once Redis says no.
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    expect(mockBookingCreate).not.toHaveBeenCalled()
  })

  // Redis said yes but Postgres is the authority and disagrees.
  it('releases the Redis holds when the DB finds a seat already booked', async () => {
    txRunsForCreateBooking({
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 's1', status: 'BOOKED', price: 2000, showtimeId: 'st1' },
      ]),
    })

    await expect(
      createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: ['s1'] }),
    ).rejects.toThrow(SeatUnavailableError)

    expect(mockRelease).toHaveBeenCalledWith(['s1'])
  })

  // Narrowing the catch to only release on SeatUnavailableError would leave
  // this fully green while stranding seats in Redis for the full TTL after
  // a connection drop or any other DB failure.
  it('releases the Redis holds when the DB fails for any other reason', async () => {
    txRunsForCreateBooking({ $queryRaw: vi.fn().mockRejectedValue(new Error('connection lost')) })

    await expect(createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: ['s1'] })).rejects.toThrow(
      'connection lost',
    )

    expect(mockRelease).toHaveBeenCalledWith(['s1'])
  })

  it('computes totalPrice from the DB rows, not from anything the caller supplied', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'b1' })
    txRunsForCreateBooking({
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 's1', status: 'AVAILABLE', price: 3500, showtimeId: 'st1', ...SCHEDULED },
        { id: 's2', status: 'AVAILABLE', price: 1200, showtimeId: 'st1', ...SCHEDULED },
      ]),
      seat: { updateMany: vi.fn() },
      booking: { create },
    })

    // A bogus `price` on the input must have zero influence — totalPrice is
    // asserted below to still be the DB-derived 4700, not 999999.
    await createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: ['s1', 's2'], price: 999999 } as never)

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ totalPrice: 4700 }) }),
    )
  })

  it('rejects seats that belong to a different showtime', async () => {
    txRunsForCreateBooking({
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 's1', status: 'AVAILABLE', price: 2000, showtimeId: 'OTHER' },
      ]),
    })

    await expect(
      createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: ['s1'] }),
    ).rejects.toThrow(SeatUnavailableError)
    expect(mockRelease).toHaveBeenCalled()
  })

  // Finding 2: the spec requires the stale-booking sweep at the start of
  // BOTH getSeatMap and the hold path. Without it, a seat freed by a booking
  // that just expired still reads BOOKED inside this function's own lock —
  // a stale tab gets a 409 for a genuinely free seat.
  it('sweeps stale bookings before opening the seat-locking transaction', async () => {
    const order: string[] = []
    // Two distinct queries now run inside the booking transaction — the new
    // Showtime lock (see below) fires first, then the seat-locking query —
    // so this counts calls to tell them apart rather than assuming there is
    // only one.
    let bookingTxQueryCalls = 0
    const queryRaw = vi.fn(async () => {
      // The very first call into the tx object is the sweep from
      // expireStaleBookings; txRuns' wrapper answers it with `[]` before
      // this fn ever runs for it, so every call that reaches here belongs to
      // the booking transaction — recording it proves the sweep already ran.
      bookingTxQueryCalls += 1
      order.push(bookingTxQueryCalls === 1 ? 'showtime-lock-query' : 'seat-lock-query')
      return [{ id: 's1', status: 'AVAILABLE', price: 1000, showtimeId: 'st1', ...SCHEDULED }]
    })
    // Wrap $transaction ourselves (bypassing txRuns) so we can also observe
    // expireStaleBookings' own $transaction call, which txRuns' sweep
    // shortcut would otherwise hide.
    let transactionCalls = 0
    mockTransaction.mockImplementation(async (fn: (t: unknown) => unknown) => {
      transactionCalls += 1
      if (transactionCalls === 1) {
        order.push('sweep-transaction')
        // Mirrors expireStaleBookings' real shape: no stale rows.
        return fn({ $queryRaw: vi.fn().mockResolvedValue([]) })
      }
      return fn({
        $queryRaw: queryRaw,
        seat: { updateMany: vi.fn() },
        booking: { create: vi.fn().mockResolvedValue({ id: 'b1' }) },
      })
    })

    await createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: ['s1'] })

    expect(order).toEqual(['sweep-transaction', 'showtime-lock-query', 'seat-lock-query'])
  })

  // Closes the race with updateShowtime: createBooking must lock the
  // Showtime row in its OWN statement, before the seat query, rather than
  // folding it into the seat query's `FOR UPDATE OF s` (see booking.ts for
  // why a combined multi-relation lock there can deadlock against a second,
  // overlapping-seat createBooking call). This is the one test that fails
  // if that lock statement is ever removed or reordered after the seat
  // query.
  it('locks the Showtime row, in its own statement, before the seat query', async () => {
    const calls: string[] = []
    let transactionCalls = 0
    mockTransaction.mockImplementation(async (fn: (t: unknown) => unknown) => {
      transactionCalls += 1
      if (transactionCalls === 1) return fn({ $queryRaw: vi.fn().mockResolvedValue([]) })

      const queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join('')
        calls.push(sql)
        // The lock query selects FROM "Showtime" directly; the seat query
        // only JOINs "Showtime" (as `t`), so this distinguishes them even
        // though both mention the table name.
        if (sql.includes('FROM "Showtime"')) return [{ id: 'st1' }]
        return [{ id: 's1', status: 'AVAILABLE', price: 1000, showtimeId: 'st1', ...SCHEDULED }]
      })
      return fn({
        $queryRaw: queryRaw,
        seat: { updateMany: vi.fn() },
        booking: { create: vi.fn().mockResolvedValue({ id: 'b1' }) },
      })
    })

    await createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: ['s1'] })

    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('"Showtime"')
    expect(calls[0]).toContain('FOR UPDATE')
    expect(calls[1]).toContain('"Seat"')
  })

  it('rejects booking a seat on a CANCELLED showtime', async () => {
    txRunsForCreateBooking({
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 's1', status: 'AVAILABLE', price: 2000, showtimeId: 'st1', showtimeStatus: 'CANCELLED', showtimeStartTime: new Date(Date.now() + 3_600_000) },
      ]),
    })

    await expect(
      createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: ['s1'] }),
    ).rejects.toThrow(SeatUnavailableError)
    expect(mockRelease).toHaveBeenCalledWith(['s1'])
  })

  it('rejects booking a seat on a showtime that has already started', async () => {
    txRunsForCreateBooking({
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 's1', status: 'AVAILABLE', price: 2000, showtimeId: 'st1', showtimeStatus: 'SCHEDULED', showtimeStartTime: new Date(Date.now() - 60_000) },
      ]),
    })

    await expect(
      createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: ['s1'] }),
    ).rejects.toThrow(SeatUnavailableError)
    expect(mockRelease).toHaveBeenCalledWith(['s1'])
  })
})

describe('expireStaleBookings', () => {
  // staleIds is what `$queryRaw ... FOR UPDATE SKIP LOCKED` returns — only
  // the bookings THIS call actually locked. SKIP LOCKED means a
  // concurrently-locked stale booking is simply absent here, not
  // present-but-unwritable, so seatsByBooking can describe more bookings
  // than staleIds to model "some other booking exists but wasn't locked by
  // us". bookingSeat.findMany's mock filters by the `where.bookingId.in`
  // the code under test actually passes, so a test can catch the code
  // reading a wider set of seats than the bookings it locked.
  function txExpire(staleIds: string[], seatsByBooking: Record<string, string[]>) {
    const queryRaw = vi.fn().mockResolvedValue(staleIds.map((id) => ({ id })))
    const bookingSeatFindMany = vi
      .fn()
      .mockImplementation(async ({ where }: { where: { bookingId: { in: string[] } } }) =>
        where.bookingId.in.flatMap((id) => (seatsByBooking[id] ?? []).map((seatId) => ({ seatId }))),
      )
    const bookingUpdateMany = vi.fn().mockResolvedValue({ count: staleIds.length })
    const seatUpdateMany = vi.fn().mockResolvedValue({ count: 0 })
    txRuns({
      $queryRaw: queryRaw,
      bookingSeat: { findMany: bookingSeatFindMany },
      booking: { updateMany: bookingUpdateMany },
      seat: { updateMany: seatUpdateMany },
    })
    return { queryRaw, bookingSeatFindMany, bookingUpdateMany, seatUpdateMany }
  }

  it('locks candidate bookings with FOR UPDATE SKIP LOCKED, scoped to PENDING_PAYMENT past expiry', async () => {
    const { queryRaw } = txExpire(['b1'], { b1: ['s1', 's2'] })

    await expireStaleBookings()

    expect(queryRaw).toHaveBeenCalledOnce()
    const sql = (queryRaw.mock.calls[0][0] as TemplateStringsArray).join('')
    expect(sql).toContain("status = 'PENDING_PAYMENT'")
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
  })

  it("returns the expired bookings' seats to AVAILABLE and reports the count", async () => {
    const { bookingUpdateMany, seatUpdateMany } = txExpire(['b1'], { b1: ['s1', 's2'] })

    const count = await expireStaleBookings()

    expect(bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['b1'] } },
      data: { status: 'EXPIRED' },
    })
    expect(seatUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1', 's2'] }, status: 'BOOKED' },
      data: { status: 'AVAILABLE' },
    })
    expect(count).toBe(1)
  })

  // The decisive case for the residual Critical: SKIP LOCKED means a
  // concurrently-held stale booking (b2) never appears in `stale` at all —
  // only b1, the one this call actually locked, does. Only b1's seats may
  // be freed. A batch update guarded only by an aggregate count (the
  // previous fix) would still see count > 0 from b1 alone and go on to free
  // b2's seats too, because seatIds was computed from the *whole* stale
  // read before the guard was even checked. Fails against that version —
  // see the fix-round report for the swapped-file proof.
  it('frees only the seats of the bookings actually locked and expired, not a wider batch', async () => {
    const { seatUpdateMany } = txExpire(['b1'], { b1: ['s1', 's2'], b2: ['s3', 's4'] })

    await expireStaleBookings()

    expect(seatUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1', 's2'] }, status: 'BOOKED' },
      data: { status: 'AVAILABLE' },
    })
  })

  it('does nothing when there are no stale bookings', async () => {
    const { bookingUpdateMany, seatUpdateMany } = txExpire([], {})

    const count = await expireStaleBookings()

    expect(count).toBe(0)
    expect(bookingUpdateMany).not.toHaveBeenCalled()
    expect(seatUpdateMany).not.toHaveBeenCalled()
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
