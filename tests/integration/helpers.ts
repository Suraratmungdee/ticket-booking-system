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
}

export async function createFixture(label: string): Promise<TestFixture> {
  const venue = await prisma.venue.create({
    data: { name: `${label} venue`, address: 'n/a' },
  })
  const event = await prisma.event.create({
    data: { title: `${label} event`, description: 'n/a', venueId: venue.id },
  })
  const showtime = await prisma.showtime.create({
    data: {
      eventId: event.id,
      startTime: new Date(),
      endTime: new Date(Date.now() + 60 * 60 * 1000),
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

  return { venueId: venue.id, eventId: event.id, showtimeId: showtime.id, seatMapId: seatMap.id, seatId: seat.id, userIds }
}

// Deletes only what createFixture created, children first to satisfy FK
// constraints. Never touches seeded venues/events/showtimes/seats.
export async function deleteFixture(fixture: TestFixture): Promise<void> {
  await prisma.bookingSeat.deleteMany({ where: { seatId: fixture.seatId } })
  await prisma.booking.deleteMany({ where: { userId: { in: fixture.userIds } } })
  await prisma.seat.deleteMany({ where: { id: fixture.seatId } })
  await prisma.seatMap.deleteMany({ where: { id: fixture.seatMapId } })
  await prisma.showtime.deleteMany({ where: { id: fixture.showtimeId } })
  await prisma.event.deleteMany({ where: { id: fixture.eventId } })
  await prisma.venue.deleteMany({ where: { id: fixture.venueId } })
  await prisma.user.deleteMany({ where: { id: { in: fixture.userIds } } })
}
