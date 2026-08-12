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
