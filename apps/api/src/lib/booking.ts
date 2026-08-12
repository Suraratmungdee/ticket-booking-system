import { prisma } from './prisma.js'
import { acquireSeatHolds, releaseSeatHolds } from './seat-lock.js'
import { MAX_SEATS_PER_BOOKING, SEAT_HOLD_TTL_SECONDS } from './config.js'

export class SeatUnavailableError extends Error {}
export class TooManySeatsError extends Error {}

type LockedSeat = {
  id: string
  status: string
  price: number
  showtimeId: string
  showtimeStatus: string
  showtimeStartTime: Date
}

export async function createBooking(input: {
  userId: string
  showtimeId: string
  seatIds: string[]
}) {
  if (input.seatIds.length < 1 || input.seatIds.length > MAX_SEATS_PER_BOOKING) throw new TooManySeatsError()

  // Sweep first: a seat freed by a booking that just expired must read as
  // AVAILABLE to this request, not as a stale BOOKED inside the lock below.
  await expireStaleBookings()

  // First gate: cheap, fast, and keeps most contenders out of the DB.
  const held = await acquireSeatHolds(input.seatIds, input.userId)
  if (!held) throw new SeatUnavailableError()

  try {
    return await prisma.$transaction(async (tx) => {
      // Lock the Showtime row FIRST, in its own statement, before touching
      // any Seat row. This closes the race with updateShowtime (which takes
      // the identical `FOR UPDATE` on this row before writing startTime —
      // see admin.ts): once we hold this lock, updateShowtime cannot commit
      // a change to startTime/status until we commit or roll back, so the
      // showtimeStatus/showtimeStartTime read a few lines below via the
      // seat join is guaranteed not to go stale between that read and our
      // decision.
      //
      // Deliberately NOT folded into the seat query below as
      // `FOR UPDATE OF s, t` (as a first draft of this fix did). Postgres's
      // LockRows executor locks a joined query's marked relations per
      // *output row*, in range-table order — so for a query joining Seat to
      // Showtime, each row locks its Seat tuple, then (the first time)
      // locks the Showtime tuple, before the next row is even fetched. That
      // attaches the Showtime lock to whichever seat happens to be each
      // transaction's own first-processed row — and that "first seat"
      // differs between two createBooking calls requesting different,
      // overlapping seat sets for the same showtime (e.g. {A,B} vs {B,C}).
      // That allows: txn1 locks A, then locks the showtime; txn2
      // concurrently locks B, then blocks on the showtime (held by txn1);
      // txn1 then tries to lock B and blocks on txn2 — a genuine deadlock,
      // not merely a theoretical one, since "two customers picking
      // different-but-overlapping seats for the same popular showtime" is
      // this system's central case. A combined multi-relation FOR UPDATE
      // cannot express "always lock the showtime before any seat, for every
      // caller" — only two separate, ordered statements can, which is what
      // this does. See task-1-report.md for the full deadlock analysis.
      //
      // The result is discarded on purpose: a bogus/mismatched showtimeId
      // just locks zero rows here, and the seat checks below (showtimeId
      // mismatch, or zero seats matched) already turn that into the same
      // SeatUnavailableError a real caller would hit.
      await tx.$queryRaw`
        SELECT id FROM "Showtime" WHERE id = ${input.showtimeId} FOR UPDATE
      `

      // The authority. FOR UPDATE blocks any concurrent transaction asking for
      // these same rows until we commit, so the status we read cannot go stale
      // between the check and the write — the check-then-act race that makes
      // naive seat booking double-book under load.
      //
      // ORDER BY id is not cosmetic: two requests selecting the same seats in
      // different orders would each hold one row and wait on the other's,
      // deadlocking. A single global order makes that impossible.
      const seats = await tx.$queryRaw<LockedSeat[]>`
        SELECT s.id, s.status::text AS status, m.price, m."showtimeId",
               t.status::text AS "showtimeStatus", t."startTime" AS "showtimeStartTime"
        FROM "Seat" s
        JOIN "SeatMap" m ON m.id = s."seatMapId"
        JOIN "Showtime" t ON t.id = m."showtimeId"
        WHERE s.id = ANY(${input.seatIds}::text[])
        ORDER BY s.id
        FOR UPDATE OF s
      `

      if (seats.length !== input.seatIds.length) throw new SeatUnavailableError()
      if (seats.some((s) => s.status !== 'AVAILABLE')) throw new SeatUnavailableError()
      if (seats.some((s) => s.showtimeId !== input.showtimeId)) throw new SeatUnavailableError()
      // A cancelled or already-started showtime can't be booked. Reused
      // SeatUnavailableError (409) rather than a new error class — a
      // probing client shouldn't be able to tell "seat taken" from
      // "showtime dead" apart, and this check lives under the same row
      // lock as the seat-status checks above.
      if (seats.some((s) => s.showtimeStatus !== 'SCHEDULED' || s.showtimeStartTime <= new Date())) {
        throw new SeatUnavailableError()
      }

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
    // minutes — nobody holds a booking for them. releaseSeatHolds fails
    // open (see seat-lock.ts) rather than throwing, so a Redis outage here
    // can't mask the real `err` (e.g. SeatUnavailableError) behind a raw
    // Redis error and turn a 409 into a 500.
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
    // SKIP LOCKED is the point: a concurrent sweep silently passes over rows
    // this one already holds, so two sweeps never process the same booking
    // and can never disagree about whose seats to free. An aggregate count
    // guard on a batch update isn't enough here — if `stale` held bookings
    // B1 and B2 and only B1 still matched at update time, the batch would
    // still report count > 0 and go on to free B2's seat too, even though
    // B2 never left PENDING_PAYMENT. Locking the candidate rows up front
    // avoids that entirely: only rows this transaction actually holds are
    // ever expired or have their seats freed.
    const stale = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Booking"
      WHERE status = 'PENDING_PAYMENT' AND "expiresAt" < now()
      FOR UPDATE SKIP LOCKED
    `
    if (stale.length === 0) return 0
    const bookingIds = stale.map((b) => b.id)

    // Seats are read from the locked bookings only — never from a wider set.
    const rows = await tx.bookingSeat.findMany({
      where: { bookingId: { in: bookingIds } },
      select: { seatId: true },
    })

    await tx.booking.updateMany({ where: { id: { in: bookingIds } }, data: { status: 'EXPIRED' } })
    // `status: 'BOOKED'` is belt-and-braces here — the SKIP LOCKED read
    // above already guarantees these seats belong only to bookings this
    // transaction just expired.
    await tx.seat.updateMany({
      where: { id: { in: rows.map((r) => r.seatId) }, status: 'BOOKED' },
      data: { status: 'AVAILABLE' },
    })
    return bookingIds.length
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
