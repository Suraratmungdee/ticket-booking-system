import { prisma } from './prisma.js'
import { getHeldSeatIds } from './seat-lock.js'
import { expireStaleBookings } from './booking.js'
import { MAX_SEATS_PER_BOOKING } from './config.js'

export async function getSeatMap(showtimeId: string) {
  // Sweep first: a seat freed by an expired booking must not still read as
  // BOOKED to the person looking at the map right now.
  await expireStaleBookings()

  const zones = await prisma.seatMap.findMany({
    where: { showtimeId },
    orderBy: { price: 'desc' },
    select: {
      zoneName: true,
      price: true,
      seats: {
        orderBy: [{ row: 'asc' }, { number: 'asc' }],
        select: { id: true, row: true, number: true, status: true },
      },
    },
  })

  const allSeatIds = zones.flatMap((z) => z.seats.map((s) => s.id))
  const heldIds = await getHeldSeatIds(allSeatIds)

  return {
    // Sent so the frontend never restates this cap itself (CLAUDE.md §4.3 —
    // one source of truth for a business rule, not a copy in the UI).
    maxSeatsPerBooking: MAX_SEATS_PER_BOOKING,
    zones: zones.map((zone) => ({
      zoneName: zone.zoneName,
      price: zone.price,
      seats: zone.seats.map((seat) => ({
        id: seat.id,
        row: seat.row,
        number: seat.number,
        // BOOKED wins: it is permanent, a hold is not.
        status: seat.status === 'BOOKED' ? 'BOOKED' : heldIds.has(seat.id) ? 'HELD' : 'AVAILABLE',
      })),
    })),
  }
}
