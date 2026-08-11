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

  // Narrowing the catch to only release on SeatUnavailableError would leave
  // this fully green while stranding seats in Redis for the full TTL after
  // a connection drop or any other DB failure.
  it('releases the Redis holds when the DB fails for any other reason', async () => {
    txRuns({ $queryRaw: vi.fn().mockRejectedValue(new Error('connection lost')) })

    await expect(createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: ['s1'] })).rejects.toThrow(
      'connection lost',
    )

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

    // A bogus `price` on the input must have zero influence — totalPrice is
    // asserted below to still be the DB-derived 4700, not 999999.
    await createBooking({ userId: 'u1', showtimeId: 'st1', seatIds: ['s1', 's2'], price: 999999 } as never)

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
