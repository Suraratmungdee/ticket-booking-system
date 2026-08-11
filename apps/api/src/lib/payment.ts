import { randomUUID } from 'node:crypto'
import { prisma } from './prisma.js'
import { PAYMENT_PROVIDER } from './config.js'

export class BookingNotPayableError extends Error {}
export class PaymentNotFoundError extends Error {}

// Creates (or returns) the provider session a user will pay against.
// Scoped by userId so a caller can only ever start checkout on their own
// booking; the route turns the resulting error into a 404, not a 403.
export async function createCheckoutSession(bookingId: string, userId: string) {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, userId } })
  if (!booking) throw new BookingNotPayableError()
  if (booking.status !== 'PENDING_PAYMENT') throw new BookingNotPayableError()
  if (booking.expiresAt <= new Date()) throw new BookingNotPayableError()

  // Clicking pay twice must not mint a second session — the seat hold and the
  // amount are unchanged, so the existing one is still the right one.
  const existing = await prisma.payment.findUnique({ where: { bookingId } })
  if (existing && existing.status === 'PENDING') {
    return { providerRef: existing.providerRef, amount: existing.amount }
  }

  const created = await prisma.payment.create({
    data: {
      bookingId,
      provider: PAYMENT_PROVIDER,
      providerRef: `sess_${randomUUID()}`,
      // From the database, never from the request.
      amount: booking.totalPrice,
      status: 'PENDING',
    },
  })
  return { providerRef: created.providerRef, amount: created.amount }
}

type SeatRow = { id: string; status: string }

export async function applyPaymentOutcome(input: {
  eventId: string
  providerRef: string
  outcome: 'succeeded' | 'failed'
}): Promise<{ applied: boolean; bookingStatus?: string }> {
  return await prisma.$transaction(async (tx) => {
    // Idempotency: the unique constraint is the arbiter, not a prior read.
    // A SELECT-then-INSERT would let two simultaneous deliveries both miss
    // and both apply the effect.
    try {
      await tx.webhookEvent.create({ data: { eventId: input.eventId } })
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002') {
        return { applied: false }
      }
      throw err
    }

    const payment = await tx.payment.findUnique({
      where: { providerRef: input.providerRef },
      include: { booking: { include: { seats: { select: { seatId: true } } } } },
    })
    if (!payment) throw new PaymentNotFoundError()

    if (input.outcome === 'failed') {
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } })
      // A failed charge never moves the booking in either direction — the
      // user can retry until the hold expires, and expiry is the sweep's job.
      return { applied: true, bookingStatus: payment.booking.status }
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'SUCCEEDED', paidAt: new Date() },
    })

    if (payment.booking.status === 'PAID') {
      return { applied: true, bookingStatus: 'PAID' }
    }

    if (payment.booking.status === 'PENDING_PAYMENT') {
      await tx.booking.update({ where: { id: payment.bookingId }, data: { status: 'PAID' } })
      return { applied: true, bookingStatus: 'PAID' }
    }

    // The money case: the hold lapsed before the webhook landed, the seats
    // were returned to the pool, and the user has already been charged.
    // Recover the booking if nobody took the seats; otherwise flag it for a
    // refund rather than taking a seat away from whoever holds it now.
    const seatIds = payment.booking.seats.map((s) => s.seatId)
    // ORDER BY id for the same reason as createBooking: one global lock
    // order, or two transactions wanting the same seats deadlock.
    const seats = await tx.$queryRaw<SeatRow[]>`
      SELECT id, status::text AS status FROM "Seat"
      WHERE id = ANY(${seatIds}::text[])
      ORDER BY id
      FOR UPDATE
    `

    const allFree = seats.length === seatIds.length && seats.every((s) => s.status === 'AVAILABLE')
    if (allFree) {
      await tx.seat.updateMany({ where: { id: { in: seatIds } }, data: { status: 'BOOKED' } })
      await tx.booking.update({ where: { id: payment.bookingId }, data: { status: 'PAID' } })
      return { applied: true, bookingStatus: 'PAID' }
    }

    // LIMITATION: this only records that a refund is owed. Nothing pays it
    // back yet — Phase 5's admin panel must surface REFUND_REQUIRED bookings,
    // or a customer stays charged for seats they never got.
    await tx.booking.update({
      where: { id: payment.bookingId },
      data: { status: 'REFUND_REQUIRED' },
    })
    return { applied: true, bookingStatus: 'REFUND_REQUIRED' }
  })
}
