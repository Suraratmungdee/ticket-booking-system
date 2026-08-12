import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  showtimeCreate: vi.fn(),
  showtimeUpdate: vi.fn(),
  showtimeQueryRaw: vi.fn(),
  seatMapCreate: vi.fn(),
  auditCreate: vi.fn(),
}))

vi.mock('../../../apps/api/src/lib/prisma', () => ({ prisma: { $transaction: m.transaction } }))

import {
  createShowtime,
  updateShowtime,
  createSeatMap,
  SeatMapTooLargeError,
} from '../../../apps/api/src/lib/admin'
import { createSeatMapHandler } from '../../../apps/api/src/routes/admin'
import { MAX_SEATS_PER_SEATMAP } from '../../../apps/api/src/lib/config'

function fakeRes() {
  const res: any = {}
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  return res
}

function txRuns() {
  m.transaction.mockImplementation(async (fn: (t: unknown) => unknown) =>
    fn({
      showtime: { create: m.showtimeCreate, update: m.showtimeUpdate },
      seatMap: { create: m.seatMapCreate },
      adminAuditLog: { create: m.auditCreate },
      $queryRaw: m.showtimeQueryRaw,
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

describe('createSeatMapHandler', () => {
  // rows: ['A', 'A'] would make createSeatMap generate two
  // { row: 'A', number: 1 } seats, tripping the @@unique([seatMapId, row,
  // number]) constraint as a raw P2002. The schema's rows.refine must catch
  // this as a 400 before createSeatMap ever runs — same shape as the cap
  // test above, asserting the transaction was never opened.
  it('rejects a duplicate row label before the transaction opens', async () => {
    const req: any = {
      user: { id: 'admin-1' },
      body: {
        showtimeId: 'st1',
        zoneName: 'ซ้ำ',
        price: 100,
        rows: ['A', 'A'],
        seatsPerRow: 2,
      },
    }
    const res = fakeRes()

    await createSeatMapHandler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it('maps a duplicate zone name to 409 rather than a 500', async () => {
    m.seatMapCreate.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }))
    const res = fakeRes()

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
})
