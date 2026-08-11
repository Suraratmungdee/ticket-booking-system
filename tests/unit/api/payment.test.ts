import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  bookingFindFirst: vi.fn(),
  paymentFindUnique: vi.fn(),
  paymentCreate: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: {
    booking: { findFirst: m.bookingFindFirst },
    payment: { findUnique: m.paymentFindUnique, create: m.paymentCreate },
    $transaction: m.transaction,
  },
}))

import {
  createCheckoutSession,
  applyPaymentOutcome,
  BookingNotPayableError,
} from '../../../apps/api/src/lib/payment'

beforeEach(() => vi.clearAllMocks())

describe('createCheckoutSession', () => {
  it('rejects a booking that is not the caller\'s', async () => {
    m.bookingFindFirst.mockResolvedValue(null)

    await expect(createCheckoutSession('b1', 'not-the-owner')).rejects.toThrow(
      BookingNotPayableError,
    )
    expect(m.paymentCreate).not.toHaveBeenCalled()
  })

  it('rejects a booking that is not PENDING_PAYMENT', async () => {
    m.bookingFindFirst.mockResolvedValue({
      id: 'b1',
      status: 'PAID',
      totalPrice: 4700,
      expiresAt: new Date(Date.now() + 60_000),
    })

    await expect(createCheckoutSession('b1', 'u1')).rejects.toThrow(BookingNotPayableError)
    expect(m.paymentCreate).not.toHaveBeenCalled()
  })

  it('rejects a booking whose hold already expired', async () => {
    m.bookingFindFirst.mockResolvedValue({
      id: 'b1',
      status: 'PENDING_PAYMENT',
      totalPrice: 4700,
      expiresAt: new Date(Date.now() - 1000),
    })

    await expect(createCheckoutSession('b1', 'u1')).rejects.toThrow(BookingNotPayableError)
  })

  it('takes the amount from the booking, not from anything a caller could supply', async () => {
    m.bookingFindFirst.mockResolvedValue({
      id: 'b1',
      status: 'PENDING_PAYMENT',
      totalPrice: 4700,
      expiresAt: new Date(Date.now() + 60_000),
    })
    m.paymentFindUnique.mockResolvedValue(null)
    m.paymentCreate.mockResolvedValue({ providerRef: 'ref_1', amount: 4700 })

    const result = await createCheckoutSession('b1', 'u1')

    expect(result.amount).toBe(4700)
    expect(m.paymentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 4700 }) }),
    )
  })

  // Clicking "pay" twice must not mint a second session.
  it('returns the existing session when a PENDING payment already exists', async () => {
    m.bookingFindFirst.mockResolvedValue({
      id: 'b1',
      status: 'PENDING_PAYMENT',
      totalPrice: 4700,
      expiresAt: new Date(Date.now() + 60_000),
    })
    m.paymentFindUnique.mockResolvedValue({ providerRef: 'ref_existing', amount: 4700, status: 'PENDING' })

    const result = await createCheckoutSession('b1', 'u1')

    expect(result.providerRef).toBe('ref_existing')
    expect(m.paymentCreate).not.toHaveBeenCalled()
  })
})

// Runs the callback against a stub transaction client.
function txRuns(tx: Record<string, unknown>) {
  m.transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx))
}

describe('applyPaymentOutcome', () => {
  it('is a no-op when the event id was already recorded', async () => {
    const bookingUpdate = vi.fn()
    txRuns({
      webhookEvent: {
        create: vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' })),
      },
      booking: { update: bookingUpdate },
    })

    const result = await applyPaymentOutcome({
      eventId: 'evt_1',
      providerRef: 'ref_1',
      outcome: 'succeeded',
    })

    expect(result.applied).toBe(false)
    expect(bookingUpdate).not.toHaveBeenCalled()
  })

  it('marks the payment FAILED and leaves the booking untouched on a failed outcome', async () => {
    const bookingUpdate = vi.fn()
    const paymentUpdate = vi.fn()
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          booking: { id: 'b1', status: 'PENDING_PAYMENT' },
        }),
        update: paymentUpdate,
      },
      booking: { update: bookingUpdate },
    })

    await applyPaymentOutcome({ eventId: 'evt_2', providerRef: 'ref_1', outcome: 'failed' })

    expect(paymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    )
    expect(bookingUpdate).not.toHaveBeenCalled()
  })

  it('marks a PENDING_PAYMENT booking PAID on success', async () => {
    const bookingUpdate = vi.fn()
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          booking: { id: 'b1', status: 'PENDING_PAYMENT' },
        }),
        update: vi.fn(),
      },
      booking: { update: bookingUpdate },
    })

    await applyPaymentOutcome({ eventId: 'evt_3', providerRef: 'ref_1', outcome: 'succeeded' })

    expect(bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PAID' }) }),
    )
  })

  it('recovers an expired booking when every seat is still free', async () => {
    const bookingUpdate = vi.fn()
    const seatUpdateMany = vi.fn()
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          booking: {
            id: 'b1',
            status: 'EXPIRED',
            seats: [{ seatId: 's1' }, { seatId: 's2' }],
          },
        }),
        update: vi.fn(),
      },
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 's1', status: 'AVAILABLE' },
        { id: 's2', status: 'AVAILABLE' },
      ]),
      seat: { updateMany: seatUpdateMany },
      booking: { update: bookingUpdate },
    })

    await applyPaymentOutcome({ eventId: 'evt_4', providerRef: 'ref_1', outcome: 'succeeded' })

    expect(seatUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'BOOKED' } }),
    )
    expect(bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PAID' }) }),
    )
  })

  // The money case: paid for, seats gone. Never take a seat from whoever holds it.
  it('flags REFUND_REQUIRED and does not touch seats when one was taken', async () => {
    const bookingUpdate = vi.fn()
    const seatUpdateMany = vi.fn()
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          booking: {
            id: 'b1',
            status: 'EXPIRED',
            seats: [{ seatId: 's1' }, { seatId: 's2' }],
          },
        }),
        update: vi.fn(),
      },
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 's1', status: 'AVAILABLE' },
        { id: 's2', status: 'BOOKED' },
      ]),
      seat: { updateMany: seatUpdateMany },
      booking: { update: bookingUpdate },
    })

    await applyPaymentOutcome({ eventId: 'evt_5', providerRef: 'ref_1', outcome: 'succeeded' })

    expect(seatUpdateMany).not.toHaveBeenCalled()
    expect(bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REFUND_REQUIRED' }) }),
    )
  })

  it('does nothing when the booking is already PAID', async () => {
    const bookingUpdate = vi.fn()
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          booking: { id: 'b1', status: 'PAID' },
        }),
        update: vi.fn(),
      },
      booking: { update: bookingUpdate },
    })

    await applyPaymentOutcome({ eventId: 'evt_6', providerRef: 'ref_1', outcome: 'succeeded' })

    expect(bookingUpdate).not.toHaveBeenCalled()
  })
})
