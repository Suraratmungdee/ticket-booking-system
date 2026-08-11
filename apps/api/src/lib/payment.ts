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

  // bookingId is @unique on Payment, so there is at most one row per booking
  // — it must be reused, not re-inserted, on every path below.
  const existing = await prisma.payment.findUnique({ where: { bookingId } })
  if (existing) {
    // Clicking pay twice must not mint a second session — the seat hold and
    // the amount are unchanged, so the existing one is still the right one.
    if (existing.status === 'PENDING') {
      return { providerRef: existing.providerRef, amount: existing.amount }
    }
    // Already paid for — never open a new session on top of a success. (The
    // booking-status check above will usually have already caught this, but
    // this does not rely on that alone.)
    if (existing.status === 'SUCCEEDED') throw new BookingNotPayableError()

    // FAILED: reset the same row for a retry rather than inserting a second
    // one — bookingId's unique constraint would reject that anyway. A fresh
    // providerRef matters: the old ref may already have a WebhookEvent
    // recorded against it, and reusing it would let a stale delivery apply
    // to this retry.
    //
    // updateMany (not update) with status: 'FAILED' in the where is the
    // compare half of a compare-and-swap — `update` has no way to condition
    // on anything but the unique key, so an unconditioned write here would
    // let two concurrent retries both succeed (last write wins, the loser's
    // minted ref never lands in the row) or let this blindly stomp a payment
    // that a late `succeeded` webhook already moved to SUCCEEDED between our
    // read above and this write.
    const freshRef = `sess_${randomUUID()}`
    const reset = await prisma.payment.updateMany({
      where: { bookingId, status: 'FAILED' },
      data: {
        providerRef: freshRef,
        // Re-read from the database in case anything about the booking
        // changed since the failed attempt — never from the request.
        amount: booking.totalPrice,
        status: 'PENDING',
      },
    })
    if (reset.count === 0) {
      // Someone else moved this payment between our read and our write —
      // act on what is actually there rather than overwriting it.
      const current = await prisma.payment.findUnique({ where: { bookingId } })
      if (!current || current.status === 'SUCCEEDED') throw new BookingNotPayableError()
      return { providerRef: current.providerRef, amount: current.amount }
    }
    return { providerRef: freshRef, amount: booking.totalPrice }
  }

  try {
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
  } catch (err) {
    // Two simultaneous clicks both read `existing` as null and both land
    // here; bookingId's unique constraint lets exactly one create() through.
    // The loser gets the winner's session instead of a raw Prisma error.
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002') {
      const winner = await prisma.payment.findUnique({ where: { bookingId } })
      if (winner) return { providerRef: winner.providerRef, amount: winner.amount }
    }
    throw err
  }
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
      // A stale/out-of-order failure (different eventId, same providerRef)
      // arriving after a success already applied must not downgrade a
      // payment that has already succeeded — that would leave Payment.FAILED
      // sitting next to Booking.PAID with nothing to reconcile them.
      if (payment.status === 'PENDING') {
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } })
      }
      // A failed charge never moves the booking in either direction — the
      // user can retry until the hold expires, and expiry is the sweep's job.
      return { applied: true, bookingStatus: payment.booking.status }
    }

    // REFUND_REQUIRED is terminal: a refund may already be sitting in an
    // admin's queue for this booking. A duplicate success delivered after
    // that must not silently clear it and re-book seats that happen to be
    // free again.
    if (payment.booking.status === 'REFUND_REQUIRED') {
      return { applied: true, bookingStatus: 'REFUND_REQUIRED' }
    }

    // Only stamp paidAt on the actual transition into SUCCEEDED — a
    // duplicate success delivery (different eventId, same providerRef) must
    // not drift the timestamp forward.
    if (payment.status !== 'SUCCEEDED') {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'SUCCEEDED', paidAt: new Date() },
      })
    }

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
