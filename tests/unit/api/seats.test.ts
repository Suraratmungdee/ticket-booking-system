import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted, not plain consts: vi.mock factories run when the mocked module
// is first imported, which Vitest hoists above ordinary top-level code
// (including plain `const`), so a bare `const mockX = vi.fn()` referenced
// inside a factory would still be in its temporal dead zone at that point.
const { mockGetHeld } = vi.hoisted(() => ({ mockGetHeld: vi.fn() }))
vi.mock('../../../apps/api/src/lib/seat-lock', () => ({ getHeldSeatIds: mockGetHeld }))

const { mockExpire } = vi.hoisted(() => ({ mockExpire: vi.fn() }))
vi.mock('../../../apps/api/src/lib/booking', () => ({ expireStaleBookings: mockExpire }))

const { mockFindMany } = vi.hoisted(() => ({ mockFindMany: vi.fn() }))
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

  // Finding 4: the frontend must not restate MAX_SEATS_PER_BOOKING itself
  // (CLAUDE.md §4.3 — one source of truth). The API is the source, so the
  // response has to carry it.
  it('includes maxSeatsPerBooking so the frontend never restates the cap', async () => {
    mockFindMany.mockResolvedValue([])

    const result = await getSeatMap('st1')

    expect(result.maxSeatsPerBooking).toBe(8)
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
