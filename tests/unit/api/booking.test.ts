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
