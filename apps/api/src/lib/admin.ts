import { prisma } from './prisma.js'
import { recordAudit } from './audit.js'
import { MAX_SEATS_PER_SEATMAP } from './config.js'

// Every mutation below follows the same shape: write, then record the audit
// entry, both inside one prisma.$transaction. Neither may land without the
// other.

export async function listVenues() {
  return prisma.venue.findMany({ orderBy: { name: 'asc' } })
}

export async function createVenue(adminId: string, input: { name: string; address: string }) {
  return prisma.$transaction(async (tx) => {
    const venue = await tx.venue.create({ data: input })
    await recordAudit(tx, {
      adminId,
      action: 'venue.create',
      targetType: 'Venue',
      targetId: venue.id,
    })
    return venue
  })
}

export async function updateVenue(
  adminId: string,
  id: string,
  input: { name?: string; address?: string },
) {
  return prisma.$transaction(async (tx) => {
    const venue = await tx.venue.update({ where: { id }, data: input })
    await recordAudit(tx, {
      adminId,
      action: 'venue.update',
      targetType: 'Venue',
      targetId: id,
    })
    return venue
  })
}

// Unlike GET /events, this is not filtered — an admin needs to see
// everything, including events with no showtimes yet.
//
// LIMITATION: no pagination. Fine at this catalog size; add a cursor once
// the list outgrows one screen.
export async function listAllEvents() {
  return prisma.event.findMany({
    orderBy: { title: 'asc' },
    include: { venue: true, showtimes: { orderBy: { startTime: 'asc' } } },
  })
}

export async function createEvent(
  adminId: string,
  input: { title: string; description: string; venueId: string },
) {
  return prisma.$transaction(async (tx) => {
    const event = await tx.event.create({ data: input })
    await recordAudit(tx, {
      adminId,
      action: 'event.create',
      targetType: 'Event',
      targetId: event.id,
    })
    return event
  })
}

export async function updateEvent(
  adminId: string,
  id: string,
  input: { title?: string; description?: string; venueId?: string },
) {
  return prisma.$transaction(async (tx) => {
    const event = await tx.event.update({ where: { id }, data: input })
    await recordAudit(tx, {
      adminId,
      action: 'event.update',
      targetType: 'Event',
      targetId: id,
    })
    return event
  })
}

export class SeatMapTooLargeError extends Error {}

export async function createShowtime(
  adminId: string,
  input: { eventId: string; startTime: Date; endTime: Date },
) {
  return prisma.$transaction(async (tx) => {
    // `status` is deliberately absent: the schema default (SCHEDULED) is the
    // only thing that ever sets it. Nothing in this phase may change it —
    // createBooking reads Showtime.status without locking that row, so a
    // runtime mutation would create a check-then-act race. See the spec.
    const showtime = await tx.showtime.create({ data: input })
    await recordAudit(tx, {
      adminId,
      action: 'showtime.create',
      targetType: 'Showtime',
      targetId: showtime.id,
    })
    return showtime
  })
}

export async function updateShowtime(
  adminId: string,
  id: string,
  input: { startTime?: Date; endTime?: Date },
) {
  return prisma.$transaction(async (tx) => {
    const showtime = await tx.showtime.update({ where: { id }, data: input })
    await recordAudit(tx, {
      adminId,
      action: 'showtime.update',
      targetType: 'Showtime',
      targetId: id,
    })
    return showtime
  })
}

// Creates the zone and every seat in it in ONE transaction. Creating seats
// one request at a time would leave a half-built zone behind whenever the
// caller stopped partway, and a zone missing seats looks sold out rather
// than broken.
export async function createSeatMap(
  adminId: string,
  input: {
    showtimeId: string
    zoneName: string
    price: number
    rows: string[]
    seatsPerRow: number
  },
) {
  const total = input.rows.length * input.seatsPerRow
  // Checked before opening the transaction — there is no reason to hold a
  // connection open to reject this. Computed and compared before any
  // Array.from below, so a huge seatsPerRow never triggers a huge
  // allocation: this multiply-then-compare always runs first.
  if (total > MAX_SEATS_PER_SEATMAP) throw new SeatMapTooLargeError()

  const seats = input.rows.flatMap((row) =>
    Array.from({ length: input.seatsPerRow }, (_, i) => ({ row, number: i + 1 })),
  )

  return prisma.$transaction(async (tx) => {
    const seatMap = await tx.seatMap.create({
      data: {
        showtimeId: input.showtimeId,
        zoneName: input.zoneName,
        // Int baht, straight from the validated request. Never a Float.
        price: input.price,
        // No `status` — the Seat schema default (AVAILABLE) is the only
        // thing that may set it. Accepting it from a caller would let an
        // admin mint pre-BOOKED seats.
        seats: { create: seats },
      },
    })
    await recordAudit(tx, {
      adminId,
      action: 'seatmap.create',
      targetType: 'SeatMap',
      targetId: seatMap.id,
    })
    return seatMap
  })
}

// LIMITATION: hard `take: 100`, no pagination. Enough at this data size; once
// a real deployment passes 100 bookings the older ones become unreachable
// from this screen and this needs cursor pagination.
const BOOKING_LIST_LIMIT = 100

export async function listBookings(filters: { status?: string; email?: string }) {
  return prisma.booking.findMany({
    where: {
      ...(filters.status ? { status: filters.status as never } : {}),
      ...(filters.email
        ? { user: { email: { contains: filters.email, mode: 'insensitive' as const } } }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: BOOKING_LIST_LIMIT,
    include: {
      user: { select: { email: true, name: true } },
      showtime: { include: { event: { select: { title: true } } } },
      seats: { include: { seat: { select: { row: true, number: true } } } },
    },
  })
}

type DashboardRow = {
  showtimeId: string
  eventTitle: string
  startTime: Date
  totalSeats: number
  occupiedSeats: number
  revenue: number
}

// Seat counts and revenue are aggregated in SEPARATE subqueries on purpose.
// Joining Seat and Booking in one pass multiplies rows against each other and
// inflates both numbers.
//
// The two figures also count different things, and the UI must label them as
// such: occupiedSeats comes from Seat.status, which createBooking sets at
// hold time, so it includes seats held but not yet paid for (correct for
// "how many are left to sell"). revenue counts only PAID bookings, because
// PENDING_PAYMENT is not money yet and REFUND_REQUIRED is money owed back.
// occupiedSeats x price will therefore not equal revenue, and should not.
export async function getDashboard(): Promise<DashboardRow[]> {
  return prisma.$queryRaw<DashboardRow[]>`
    SELECT
      t.id AS "showtimeId",
      e.title AS "eventTitle",
      t."startTime",
      COALESCE(seats.total, 0)::int AS "totalSeats",
      COALESCE(seats.occupied, 0)::int AS "occupiedSeats",
      COALESCE(rev.revenue, 0)::int AS "revenue"
    FROM "Showtime" t
    JOIN "Event" e ON e.id = t."eventId"
    LEFT JOIN (
      SELECT m."showtimeId",
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE s.status = 'BOOKED') AS occupied
      FROM "SeatMap" m
      JOIN "Seat" s ON s."seatMapId" = m.id
      GROUP BY m."showtimeId"
    ) seats ON seats."showtimeId" = t.id
    LEFT JOIN (
      SELECT b."showtimeId", SUM(b."totalPrice") AS revenue
      FROM "Booking" b
      WHERE b.status = 'PAID'
      GROUP BY b."showtimeId"
    ) rev ON rev."showtimeId" = t.id
    ORDER BY t."startTime" DESC
  `
}
