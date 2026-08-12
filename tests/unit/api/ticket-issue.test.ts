import { describe, it, expect, vi, beforeEach } from 'vitest'
import { issueTicket, verifyTicketPayload } from '../../../apps/api/src/lib/ticket'

function fakeTx(create: ReturnType<typeof vi.fn>) {
  return { ticket: { create } } as never
}

beforeEach(() => vi.clearAllMocks())

describe('issueTicket', () => {
  it('creates a ticket whose payload verifies back to its own id', async () => {
    const create = vi.fn().mockResolvedValue({})
    await issueTicket(fakeTx(create), 'b1')

    expect(create).toHaveBeenCalledTimes(1)
    const { data } = create.mock.calls[0][0]
    expect(data.bookingId).toBe('b1')
    // The signature must cover the id actually stored on the row, or a
    // scanner would verify a payload that points at a different ticket.
    expect(verifyTicketPayload(data.qrCodePayload)).toBe(data.id)
  })

  // A caught-and-swallowed P2002 here would NOT resume the transaction —
  // Postgres has already aborted it, so the earlier booking/payment writes
  // in the same transaction would silently roll back at COMMIT while the
  // caller believes it succeeded. The error must propagate so the
  // transaction aborts honestly and the webhook route returns 500.
  it('propagates a unique-constraint violation when a ticket already exists (duplicate webhook delivery)', async () => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }))
    await expect(issueTicket(fakeTx(create), 'b1')).rejects.toThrow('dup')
  })

  it('propagates errors that are not a unique-constraint violation', async () => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'P1001' }))
    await expect(issueTicket(fakeTx(create), 'b1')).rejects.toThrow('boom')
  })
})
