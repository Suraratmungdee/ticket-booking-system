import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  ticketFindMany: vi.fn(),
  ticketFindFirst: vi.fn(),
}))

vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: { ticket: { findMany: m.ticketFindMany, findFirst: m.ticketFindFirst } },
}))

import { listMyTicketsHandler, getTicketHandler } from '../../../apps/api/src/routes/tickets'

beforeEach(() => vi.clearAllMocks())

function fakeRes() {
  const res: Record<string, unknown> = { statusCode: 200 }
  res.status = (code: number) => {
    res.statusCode = code
    return res
  }
  res.json = (body: unknown) => {
    res.body = body
    return res
  }
  return res as { statusCode: number; body?: unknown; status: unknown; json: unknown }
}

describe('GET /me/tickets', () => {
  it('returns 401 without a session', async () => {
    const res = fakeRes()
    await listMyTicketsHandler({ user: undefined } as never, res as never, vi.fn())
    expect(res.statusCode).toBe(401)
    expect(m.ticketFindMany).not.toHaveBeenCalled()
  })

  it('scopes the query to the caller, not to a client-supplied id', async () => {
    m.ticketFindMany.mockResolvedValue([])
    const res = fakeRes()
    await listMyTicketsHandler(
      { user: { id: 'u1' }, query: { userId: 'someone-else' } } as never,
      res as never,
      vi.fn(),
    )
    expect(m.ticketFindMany.mock.calls[0][0].where).toEqual({ booking: { userId: 'u1' } })
  })
})

describe('GET /tickets/:id', () => {
  it('returns 401 without a session', async () => {
    const res = fakeRes()
    await getTicketHandler({ params: { id: 't1' }, user: undefined } as never, res as never, vi.fn())
    expect(res.statusCode).toBe(401)
  })

  // 404 not 403: a 403 would confirm the id exists and let a caller
  // enumerate other people's tickets.
  it("returns 404 for someone else's ticket", async () => {
    m.ticketFindFirst.mockResolvedValue(null)
    const res = fakeRes()
    await getTicketHandler(
      { params: { id: 't1' }, user: { id: 'u1' } } as never,
      res as never,
      vi.fn(),
    )
    expect(res.statusCode).toBe(404)
  })

  it('scopes the lookup by owner inside the query', async () => {
    m.ticketFindFirst.mockResolvedValue(null)
    const res = fakeRes()
    await getTicketHandler(
      { params: { id: 't1' }, user: { id: 'u1' } } as never,
      res as never,
      vi.fn(),
    )
    expect(m.ticketFindFirst.mock.calls[0][0].where).toEqual({
      id: 't1',
      booking: { userId: 'u1' },
    })
  })

  it('returns the ticket with a QR data URL', async () => {
    m.ticketFindFirst.mockResolvedValue({
      id: 't1',
      qrCodePayload: 't1.abc',
      issuedAt: new Date('2026-08-12T00:00:00Z'),
      booking: {
        id: 'b1',
        showtime: {
          startTime: new Date('2026-09-01T12:00:00Z'),
          event: { title: 'คอนเสิร์ตทดสอบ', venue: { name: 'หอประชุม' } },
        },
        seats: [{ seat: { row: 'A', number: 1, seatMap: { zoneName: 'โซน A' } } }],
      },
    })
    const res = fakeRes()
    await getTicketHandler(
      { params: { id: 't1' }, user: { id: 'u1' } } as never,
      res as never,
      vi.fn(),
    )
    expect(res.statusCode).toBe(200)
    const body = res.body as { ticket: { qrDataUrl: string } }
    expect(body.ticket.qrDataUrl).toMatch(/^data:image\/png;base64,/)
  })
})
