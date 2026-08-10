import { prisma } from './prisma.js'
import { acquireSeatHolds, releaseSeatHolds } from './seat-lock.js'
import { MAX_SEATS_PER_BOOKING, SEAT_HOLD_TTL_SECONDS } from './config.js'

export class SeatUnavailableError extends Error {}
export class TooManySeatsError extends Error {}

type LockedSeat = { id: string; status: string; price: number; showtimeId: string }

export async function createBooking(input: {
  userId: string
  showtimeId: string
  seatIds: string[]
}) {
  if (input.seatIds.length < 1 || input.seatIds.length > MAX_SEATS_PER_BOOKING) throw new TooManySeatsError()

  // First gate: cheap, fast, and keeps most contenders out of the DB.
  const held = await acquireSeatHolds(input.seatIds, input.userId)
  if (!held) throw new SeatUnavailableError()

  try {
    return await prisma.$transaction(async (tx) => {
      // The authority. FOR UPDATE blocks any concurrent transaction asking for
      // these same rows until we commit, so the status we read cannot go stale
      // between the check and the write — the check-then-act race that makes
      // naive seat booking double-book under load.
      //
      // ORDER BY id is not cosmetic: two requests selecting the same seats in
      // different orders would each hold one row and wait on the other's,
      // deadlocking. A single global order makes that impossible.
      const seats = await tx.$queryRaw<LockedSeat[]>`
        SELECT s.id, s.status::text AS status, m.price, m."showtimeId"
        FROM "Seat" s
        JOIN "SeatMap" m ON m.id = s."seatMapId"
        WHERE s.id = ANY(${input.seatIds}::text[])
        ORDER BY s.id
        FOR UPDATE OF s
      `

      if (seats.length !== input.seatIds.length) throw new SeatUnavailableError()
      if (seats.some((s) => s.status !== 'AVAILABLE')) throw new SeatUnavailableError()
      if (seats.some((s) => s.showtimeId !== input.showtimeId)) throw new SeatUnavailableError()

      // Price comes from the joined SeatMap rows we just locked — never from
      // the request body.
      const totalPrice = seats.reduce((sum, s) => sum + s.price, 0)

      await tx.seat.updateMany({
        where: { id: { in: input.seatIds } },
        data: { status: 'BOOKED' },
      })

      return await tx.booking.create({
        data: {
          userId: input.userId,
          showtimeId: input.showtimeId,
          status: 'PENDING_PAYMENT',
          totalPrice,
          expiresAt: new Date(Date.now() + SEAT_HOLD_TTL_SECONDS * 1000),
          seats: { create: input.seatIds.map((seatId) => ({ seatId })) },
        },
        include: { seats: true },
      })
    })
  } catch (err) {
    // Whatever went wrong, don't leave the seats locked in Redis for 5
    // minutes — nobody holds a booking for them.
    await releaseSeatHolds(input.seatIds)
    throw err
  }
}

// Returns seats to the pool for bookings that were never paid for.
//
// ponytail: swept lazily from read paths rather than by a scheduled worker —
// no extra process, and a seat only needs to look free at the moment someone
// looks. If seats must free themselves on time even with nobody watching,
// promote this to a cron job.
export async function expireStaleBookings(): Promise<number> {
  return await prisma.$transaction(async (tx) => {
    const stale = await tx.booking.findMany({
      where: { status: 'PENDING_PAYMENT', expiresAt: { lt: new Date() } },
      select: { id: true, seats: { select: { seatId: true } } },
    })
    if (stale.length === 0) return 0

    const seatIds = stale.flatMap((b) => b.seats.map((s) => s.seatId))

    // Booking update goes first, guarded on status still being
    // PENDING_PAYMENT. Two concurrent sweeps can both read the same stale
    // booking before either writes; without the guard, a sweep that read
    // stale would free seats a *new* booking has since legitimately taken
    // (booking B expires, seat frees, booking C legitimately takes it, the
    // other stale sweep then frees the seat out from under C). The guarded
    // update makes the second sweep match 0 rows once the first commits, so
    // it returns before touching any seat. `status: 'BOOKED'` on the seat
    // update is belt-and-braces for the same reason.
    const expired = await tx.booking.updateMany({
      where: { id: { in: stale.map((b) => b.id) }, status: 'PENDING_PAYMENT' },
      data: { status: 'EXPIRED' },
    })
    if (expired.count === 0) return 0

    await tx.seat.updateMany({
      where: { id: { in: seatIds }, status: 'BOOKED' },
      data: { status: 'AVAILABLE' },
    })
    return expired.count
  })
}

// Scoped by userId so a caller can only ever read their own booking. The
// route turns a null into 404 rather than 403, so ids can't be probed.
export async function getBookingForUser(bookingId: string, userId: string) {
  return await prisma.booking.findFirst({
    where: { id: bookingId, userId },
    include: {
      showtime: { include: { event: { include: { venue: true } } } },
      seats: { include: { seat: { include: { seatMap: true } } } },
    },
  })
}
