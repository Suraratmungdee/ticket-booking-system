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
  // vi.clearAllMocks() clears call history but not a prior test's
  // mockRejectedValue — without this a rejection configured in one test
  // would leak into every test that runs after it.
  m.auditCreate.mockResolvedValue(undefined)
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

  // Edge case beyond the brief: a single huge seatsPerRow with just one row
  // is exactly the shape (rows.length small, seatsPerRow enormous) where a
  // naive cap check could be tempted to build the array before checking it.
  // This asserts the rejection happens (and stays cheap) without ever
  // touching the transaction, no matter how large seatsPerRow is — the
  // multiply-then-compare in createSeatMap must run before any
  // Array.from allocation.
  it('rejects a huge seatsPerRow on a single row without allocating seats', async () => {
    await expect(
      createSeatMap('admin-1', {
        showtimeId: 'st1',
        zoneName: 'แถวเดียวแต่เยอะ',
        price: 100,
        rows: ['A'],
        seatsPerRow: 10_000_000,
      }),
    ).rejects.toThrow(SeatMapTooLargeError)

    expect(m.transaction).not.toHaveBeenCalled()
  })

  // The zod schema at the route boundary (rows.min(1), seatsPerRow
  // .int().positive()) is what actually stops these values reaching this
  // function in production. This test documents that even if that boundary
  // were bypassed, the cap arithmetic degrades safely rather than minting
  // more seats than requested: JS's Array.from clamps a negative or zero
  // length to 0, so the *real* seat count generated can never exceed the
  // `total` used by the cap comparison — there is no way to dodge the cap
  // by feeding it degenerate numbers.
  it('never generates more seats than the cap even with degenerate rows/seatsPerRow', async () => {
    m.seatMapCreate.mockResolvedValue({ id: 'sm1' })

    await createSeatMap('admin-1', {
      showtimeId: 'st1',
      zoneName: 'ว่างเปล่า',
      price: 100,
      rows: [],
      seatsPerRow: 5,
    })

    expect(m.seatMapCreate.mock.calls[0][0].data.seats.create).toHaveLength(0)
  })
})
