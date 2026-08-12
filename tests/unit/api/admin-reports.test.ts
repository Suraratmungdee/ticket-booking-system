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
