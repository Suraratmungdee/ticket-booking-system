import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  bookingFindFirst: vi.fn(),
  paymentFindUnique: vi.fn(),
  paymentCreate: vi.fn(),
  paymentUpdateMany: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: {
    booking: { findFirst: m.bookingFindFirst },
    payment: { findUnique: m.paymentFindUnique, create: m.paymentCreate, updateMany: m.paymentUpdateMany },
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

  // A declined card must not permanently dead-end checkout — bookingId is
  // @unique on Payment, so the FAILED row has to be reset, not re-inserted.
  it('resets a FAILED payment for retry with a fresh providerRef', async () => {
    m.bookingFindFirst.mockResolvedValue({
      id: 'b1',
      status: 'PENDING_PAYMENT',
      totalPrice: 4700,
      expiresAt: new Date(Date.now() + 60_000),
    })
    m.paymentFindUnique.mockResolvedValue({
      providerRef: 'ref_old_failed',
      amount: 4700,
      status: 'FAILED',
    })
    m.paymentUpdateMany.mockResolvedValue({ count: 1 })

    const result = await createCheckoutSession('b1', 'u1')

    expect(result.providerRef).toMatch(/^sess_/)
    expect(m.paymentCreate).not.toHaveBeenCalled()
    expect(m.paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // The compare half of compare-and-swap: only a row still FAILED may
        // be reset, or two concurrent retries could both "succeed".
        where: { bookingId: 'b1', status: 'FAILED' },
        data: expect.objectContaining({ status: 'PENDING', amount: 4700 }),
      }),
    )
    // The retry must not reuse the ref a stale delivery could still land on.
    expect(m.paymentUpdateMany.mock.calls[0][0].data.providerRef).not.toBe('ref_old_failed')
    expect(result.providerRef).toBe(m.paymentUpdateMany.mock.calls[0][0].data.providerRef)
  })

  it('rejects starting a new session when the payment already succeeded', async () => {
    m.bookingFindFirst.mockResolvedValue({
      id: 'b1',
      status: 'PENDING_PAYMENT',
      totalPrice: 4700,
      expiresAt: new Date(Date.now() + 60_000),
    })
    m.paymentFindUnique.mockResolvedValue({
      providerRef: 'ref_paid',
      amount: 4700,
      status: 'SUCCEEDED',
    })

    await expect(createCheckoutSession('b1', 'u1')).rejects.toThrow(BookingNotPayableError)
    expect(m.paymentCreate).not.toHaveBeenCalled()
    expect(m.paymentUpdateMany).not.toHaveBeenCalled()
  })

  // Two concurrent retries both read status: 'FAILED'; only one updateMany
  // can match the `status: 'FAILED'` predicate once the other has already
  // flipped the row to PENDING. The loser must hand back the row that is
  // actually there, not the ref it minted and never wrote.
  it('returns the winning row when a concurrent FAILED-reset loses the compare-and-swap', async () => {
    m.bookingFindFirst.mockResolvedValue({
      id: 'b1',
      status: 'PENDING_PAYMENT',
      totalPrice: 4700,
      expiresAt: new Date(Date.now() + 60_000),
    })
    m.paymentFindUnique
      .mockResolvedValueOnce({ providerRef: 'ref_old_failed', amount: 4700, status: 'FAILED' })
      .mockResolvedValueOnce({ providerRef: 'ref_winner', amount: 4700, status: 'PENDING' })
    m.paymentUpdateMany.mockResolvedValue({ count: 0 })

    const result = await createCheckoutSession('b1', 'u1')

    // The where clause is the compare half of the swap — without a
    // status: 'FAILED' predicate there is nothing to make this race safe,
    // so pin it down directly rather than only asserting the outcome.
    expect(m.paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bookingId: 'b1', status: 'FAILED' } }),
    )
    expect(result.providerRef).toBe('ref_winner')
    expect(result.providerRef).not.toBe(m.paymentUpdateMany.mock.calls[0][0].data.providerRef)
  })

  // Same race, but the other side won by landing a success — the reset must
  // not resurrect a SUCCEEDED payment back to PENDING.
  it('rejects the FAILED-reset when a concurrent success won the compare-and-swap', async () => {
    m.bookingFindFirst.mockResolvedValue({
      id: 'b1',
      status: 'PENDING_PAYMENT',
      totalPrice: 4700,
      expiresAt: new Date(Date.now() + 60_000),
    })
    m.paymentFindUnique
      .mockResolvedValueOnce({ providerRef: 'ref_old_failed', amount: 4700, status: 'FAILED' })
      .mockResolvedValueOnce({ providerRef: 'ref_succeeded', amount: 4700, status: 'SUCCEEDED' })
    m.paymentUpdateMany.mockResolvedValue({ count: 0 })

    await expect(createCheckoutSession('b1', 'u1')).rejects.toThrow(BookingNotPayableError)
    expect(m.paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bookingId: 'b1', status: 'FAILED' } }),
    )
  })

  // Two simultaneous "pay" clicks: both read `existing` as null and both
  // call create(); the loser must get the winner's session, not a thrown
  // Prisma error.
  it('returns the winning session when a concurrent click loses the create race', async () => {
    m.bookingFindFirst.mockResolvedValue({
      id: 'b1',
      status: 'PENDING_PAYMENT',
      totalPrice: 4700,
      expiresAt: new Date(Date.now() + 60_000),
    })
    m.paymentFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ providerRef: 'ref_winner', amount: 4700 })
    m.paymentCreate.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }))

    const result = await createCheckoutSession('b1', 'u1')

    expect(result.providerRef).toBe('ref_winner')
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
          status: 'PENDING',
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

  // A stale/out-of-order failure (different eventId, same providerRef)
  // arriving after a success already applied must not downgrade the payment
  // — that would leave Payment.FAILED sitting next to Booking.PAID forever.
  it('ignores a failed outcome for a payment that already succeeded', async () => {
    const bookingUpdate = vi.fn()
    const paymentUpdate = vi.fn()
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          status: 'SUCCEEDED',
          booking: { id: 'b1', status: 'PAID' },
        }),
        update: paymentUpdate,
      },
      booking: { update: bookingUpdate },
    })

    const result = await applyPaymentOutcome({ eventId: 'evt_stale', providerRef: 'ref_1', outcome: 'failed' })

    expect(paymentUpdate).not.toHaveBeenCalled()
    expect(bookingUpdate).not.toHaveBeenCalled()
    expect(result.bookingStatus).toBe('PAID')
  })

  it('marks a PENDING_PAYMENT booking PAID on success', async () => {
    const bookingUpdateMany = vi.fn().mockResolvedValue({ count: 1 })
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          status: 'PENDING',
          booking: { id: 'b1', status: 'PENDING_PAYMENT' },
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      booking: { update: vi.fn(), updateMany: bookingUpdateMany },
    })

    const result = await applyPaymentOutcome({ eventId: 'evt_3', providerRef: 'ref_1', outcome: 'succeeded' })

    expect(bookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'b1', status: 'PENDING_PAYMENT' },
        data: { status: 'PAID' },
      }),
    )
    expect(result.bookingStatus).toBe('PAID')
  })

  // The compare-and-swap that closes CRITICAL 1: expireStaleBookings() can
  // commit EXPIRED on this same booking between the stale read at the top of
  // the transaction and this write. Losing the CAS (count: 0) must not be
  // silently treated as success — it must fall through to the seat re-check
  // below rather than returning early, and the fall-through's outcome must
  // honestly reflect whether the seats are still free. This fails if the
  // updateMany is ever reverted back to an unconditioned update().
  it('falls through to the seat re-check when the expiry sweep wins the race, and recovers when seats are free', async () => {
    const bookingUpdate = vi.fn()
    const bookingUpdateMany = vi.fn().mockResolvedValue({ count: 0 })
    const seatUpdateMany = vi.fn()
    const queryRaw = vi.fn().mockResolvedValue([
      { id: 's1', status: 'AVAILABLE' },
      { id: 's2', status: 'AVAILABLE' },
    ])
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          status: 'PENDING',
          // Stale read: the webhook's transaction saw this before the
          // sweep's FOR UPDATE SKIP LOCKED committed EXPIRED underneath it.
          booking: { id: 'b1', status: 'PENDING_PAYMENT', seats: [{ seatId: 's1' }, { seatId: 's2' }] },
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: queryRaw,
      seat: { updateMany: seatUpdateMany },
      booking: { update: bookingUpdate, updateMany: bookingUpdateMany },
    })

    const result = await applyPaymentOutcome({ eventId: 'evt_race_1', providerRef: 'ref_1', outcome: 'succeeded' })

    expect(bookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'b1', status: 'PENDING_PAYMENT' }, data: { status: 'PAID' } }),
    )
    expect(queryRaw).toHaveBeenCalled()
    expect(seatUpdateMany).toHaveBeenCalled()
    expect(bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PAID' }) }),
    )
    expect(result.bookingStatus).toBe('PAID')
  })

  it('falls through to the seat re-check when the expiry sweep wins the race, and flags REFUND_REQUIRED when a seat is gone', async () => {
    const bookingUpdate = vi.fn()
    const bookingUpdateMany = vi.fn().mockResolvedValue({ count: 0 })
    const seatUpdateMany = vi.fn()
    const queryRaw = vi.fn().mockResolvedValue([
      { id: 's1', status: 'AVAILABLE' },
      { id: 's2', status: 'BOOKED' },
    ])
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          status: 'PENDING',
          booking: { id: 'b1', status: 'PENDING_PAYMENT', seats: [{ seatId: 's1' }, { seatId: 's2' }] },
        }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: queryRaw,
      seat: { updateMany: seatUpdateMany },
      booking: { update: bookingUpdate, updateMany: bookingUpdateMany },
    })

    const result = await applyPaymentOutcome({ eventId: 'evt_race_2', providerRef: 'ref_1', outcome: 'succeeded' })

    expect(bookingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'b1', status: 'PENDING_PAYMENT' } }),
    )
    expect(queryRaw).toHaveBeenCalled()
    expect(seatUpdateMany).not.toHaveBeenCalled()
    expect(bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REFUND_REQUIRED' }) }),
    )
    expect(result.bookingStatus).toBe('REFUND_REQUIRED')
  })

  // The compare-and-swap that closes IMPORTANT 2: a checkout retry's own CAS
  // (in createCheckoutSession) can reset this same payment row onto a fresh
  // providerRef between this webhook's read and this write. Losing that race
  // must be a no-op, not a stamp onto the row now carrying a different ref.
  it('treats a lost providerRef compare-and-swap as a no-op, since a checkout retry already reset the row', async () => {
    const bookingUpdate = vi.fn()
    const paymentUpdateMany = vi.fn().mockResolvedValue({ count: 0 })
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          status: 'PENDING',
          booking: { id: 'b1', status: 'PENDING_PAYMENT', seats: [] },
        }),
        update: vi.fn(),
        updateMany: paymentUpdateMany,
      },
      booking: { update: bookingUpdate, updateMany: vi.fn() },
    })

    const result = await applyPaymentOutcome({
      eventId: 'evt_stale_ref',
      providerRef: 'ref_old',
      outcome: 'succeeded',
    })

    expect(paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1', providerRef: 'ref_old' },
        data: expect.objectContaining({ status: 'SUCCEEDED' }),
      }),
    )
    expect(result).toEqual({ applied: false })
    expect(bookingUpdate).not.toHaveBeenCalled()
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
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      booking: { update: bookingUpdate },
    })

    await applyPaymentOutcome({ eventId: 'evt_6', providerRef: 'ref_1', outcome: 'succeeded' })

    expect(bookingUpdate).not.toHaveBeenCalled()
  })

  // REFUND_REQUIRED is terminal: a duplicate success delivered after the
  // refund flag was already set must not silently clear it and re-book
  // seats that happen to be free again.
  it('leaves a REFUND_REQUIRED booking untouched on a duplicate success', async () => {
    const bookingUpdate = vi.fn()
    const seatUpdateMany = vi.fn()
    const queryRaw = vi.fn()
    txRuns({
      webhookEvent: { create: vi.fn().mockResolvedValue({}) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1',
          bookingId: 'b1',
          status: 'SUCCEEDED',
          booking: { id: 'b1', status: 'REFUND_REQUIRED', seats: [{ seatId: 's1' }] },
        }),
        update: vi.fn(),
      },
      $queryRaw: queryRaw,
      seat: { updateMany: seatUpdateMany },
      booking: { update: bookingUpdate },
    })

    const result = await applyPaymentOutcome({ eventId: 'evt_7', providerRef: 'ref_1', outcome: 'succeeded' })

    expect(queryRaw).not.toHaveBeenCalled()
    expect(seatUpdateMany).not.toHaveBeenCalled()
    expect(bookingUpdate).not.toHaveBeenCalled()
    expect(result.bookingStatus).toBe('REFUND_REQUIRED')
  })

  // The allFree guard has two halves: every seat AVAILABLE, and every seat
  // row present at all. A seat row missing entirely must fail closed too.
  it('flags REFUND_REQUIRED when a seat row is missing from the lock read', async () => {
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
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: 's1', status: 'AVAILABLE' }]),
      seat: { updateMany: seatUpdateMany },
      booking: { update: bookingUpdate },
    })

    await applyPaymentOutcome({ eventId: 'evt_8', providerRef: 'ref_1', outcome: 'succeeded' })

    expect(seatUpdateMany).not.toHaveBeenCalled()
    expect(bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REFUND_REQUIRED' }) }),
    )
  })
})
