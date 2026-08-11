import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const m = vi.hoisted(() => ({ bookingFindUnique: vi.fn() }))

vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: { booking: { findUnique: m.bookingFindUnique } },
}))

const ORIGINAL_KEY = process.env.RESEND_API_KEY

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY
  else process.env.RESEND_API_KEY = ORIGINAL_KEY
  vi.unstubAllGlobals()
})

const INPUT = {
  to: 'buyer@example.com',
  bookingId: 'b1',
  eventTitle: 'คอนเสิร์ตทดสอบ',
  startTime: new Date('2026-09-01T12:00:00Z'),
  seats: ['A1', 'A2'],
  ticketUrl: 'http://localhost:3000/me/tickets/t1',
}

describe('sendBookingConfirmation', () => {
  it('posts to Resend when an API key is configured', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' })
    vi.stubGlobal('fetch', fetchMock)

    const { sendBookingConfirmation } = await import('../../../apps/api/src/lib/email')
    await sendBookingConfirmation(INPUT)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers.Authorization).toBe('Bearer test-key')
    const body = JSON.parse(init.body)
    expect(body.to).toEqual(['buyer@example.com'])
    expect(body.html).toContain('http://localhost:3000/me/tickets/t1')
    expect(body.html).toContain('A1')
  })

  it('logs instead of sending when no API key is configured', async () => {
    delete process.env.RESEND_API_KEY
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    const { sendBookingConfirmation } = await import('../../../apps/api/src/lib/email')
    await sendBookingConfirmation(INPUT)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalled()
    info.mockRestore()
  })

  it('throws when Resend rejects the request, so the caller can log it', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => 'bad domain' }),
    )

    const { sendBookingConfirmation } = await import('../../../apps/api/src/lib/email')
    await expect(sendBookingConfirmation(INPUT)).rejects.toThrow(/422/)
  })
})

describe('notifyBookingPaid', () => {
  it('does nothing when the booking has no ticket yet', async () => {
    m.bookingFindUnique.mockResolvedValue(null)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { notifyBookingPaid } = await import('../../../apps/api/src/lib/email')
    await notifyBookingPaid('b1')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends to the booking owner with the ticket link', async () => {
    process.env.RESEND_API_KEY = 'test-key'
    m.bookingFindUnique.mockResolvedValue({
      id: 'b1',
      user: { email: 'buyer@example.com' },
      ticket: { id: 't1' },
      showtime: { startTime: new Date('2026-09-01T12:00:00Z'), event: { title: 'คอนเสิร์ตทดสอบ' } },
      seats: [{ seat: { row: 'A', number: 1 } }],
    })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' })
    vi.stubGlobal('fetch', fetchMock)

    const { notifyBookingPaid } = await import('../../../apps/api/src/lib/email')
    await notifyBookingPaid('b1')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.to).toEqual(['buyer@example.com'])
    expect(body.html).toContain('/me/tickets/t1')
    expect(body.html).toContain('A1')
  })
})
