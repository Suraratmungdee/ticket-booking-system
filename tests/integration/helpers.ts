// Shared setup/teardown for the concurrency tests. Each test file owns a
// dedicated Venue → Event → Showtime → SeatMap → Seat chain plus its own
// users, so it never touches seeded data or another test's rows — safe to
// run repeatedly against a shared, long-lived dev database.
import { prisma } from '../../apps/api/src/lib/prisma'

export type TestFixture = {
  venueId: string
  eventId: string
  showtimeId: string
  seatMapId: string
  seatId: string
  userIds: string[]
  // Only populated when the matching FixtureOptions flag is set — the seat
  // tests never request a booking/payment, so these stay '' for them and
  // deleteFixture skips the extra cleanup.
  bookingId: string
  providerRef: string
}

export type FixtureOptions = {
  withBooking?: boolean
  // Requires withBooking; a payment needs a booking to attach to.
  withPendingPayment?: boolean
}

// Accepts either the original bare label (existing seat tests) or an
// options object (payment-idempotency test) — kept as one function so
// callers don't need to learn two names, new behavior defaults to off.
export async function createFixture(labelOrOptions: string | FixtureOptions = {}): Promise<TestFixture> {
  const label = typeof labelOrOptions === 'string' ? labelOrOptions : 'fixture'
  const options = typeof labelOrOptions === 'string' ? {} : labelOrOptions
  const venue = await prisma.venue.create({
    data: { name: `${label} venue`, address: 'n/a' },
  })
  const event = await prisma.event.create({
    data: { title: `${label} event`, description: 'n/a', venueId: venue.id },
  })
  const showtime = await prisma.showtime.create({
    data: {
      eventId: event.id,
      // Must be in the future: createBooking now rejects a showtime whose
      // startTime has already passed (finding 3). `new Date()` here would
      // be in the past by the time the booking calls run, and every
      // concurrent request in these tests would 409 for the wrong reason.
      startTime: new Date(Date.now() + 60 * 60 * 1000),
      endTime: new Date(Date.now() + 2 * 60 * 60 * 1000),
    },
  })
  const seatMap = await prisma.seatMap.create({
    data: { showtimeId: showtime.id, zoneName: 'A', price: 1000 },
  })
  const seat = await prisma.seat.create({
    data: { seatMapId: seatMap.id, row: 'A', number: 1 },
  })

  const userIds: string[] = []
  for (let i = 0; i < 20; i++) {
    const user = await prisma.user.create({
      data: {
        email: `${label}-${i}-${Date.now()}@example.com`,
        passwordHash: 'x',
        name: `Tester ${i}`,
      },
    })
    userIds.push(user.id)
  }

  let bookingId = ''
  let providerRef = ''
  if (options.withBooking) {
    const booking = await prisma.booking.create({
      data: {
        userId: userIds[0],
        showtimeId: showtime.id,
        status: 'PENDING_PAYMENT',
        totalPrice: seatMap.price,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        seats: { create: [{ seatId: seat.id }] },
      },
    })
    bookingId = booking.id

    if (options.withPendingPayment) {
      const payment = await prisma.payment.create({
        data: {
          bookingId: booking.id,
          provider: 'mock',
          providerRef: `pr_test_${label}_${booking.id}`,
          amount: booking.totalPrice,
          status: 'PENDING',
        },
      })
      providerRef = payment.providerRef
    }
  }

  return {
    venueId: venue.id,
    eventId: event.id,
    showtimeId: showtime.id,
    seatMapId: seatMap.id,
    seatId: seat.id,
    userIds,
    bookingId,
    providerRef,
  }
}

// Deletes only what createFixture created, children first to satisfy FK
// constraints. Never touches seeded venues/events/showtimes/seats.
export async function deleteFixture(fixture: TestFixture): Promise<void> {
  await prisma.bookingSeat.deleteMany({ where: { seatId: fixture.seatId } })
  if (fixture.bookingId) {
    // The success path now issues a Ticket in the same transaction as PAID
    // (Ticket.bookingId -> Booking, no cascade) — delete it before the
    // booking or booking.deleteMany below violates the FK.
    await prisma.ticket.deleteMany({ where: { bookingId: fixture.bookingId } })
    await prisma.payment.deleteMany({ where: { bookingId: fixture.bookingId } })
  }
  await prisma.booking.deleteMany({ where: { userId: { in: fixture.userIds } } })
  await prisma.seat.deleteMany({ where: { id: fixture.seatId } })
  await prisma.seatMap.deleteMany({ where: { id: fixture.seatMapId } })
  await prisma.showtime.deleteMany({ where: { id: fixture.showtimeId } })
  await prisma.event.deleteMany({ where: { id: fixture.eventId } })
  await prisma.venue.deleteMany({ where: { id: fixture.venueId } })
  await prisma.user.deleteMany({ where: { id: { in: fixture.userIds } } })
}
