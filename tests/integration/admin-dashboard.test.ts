import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { prisma } from '../../apps/api/src/lib/prisma'
import { getDashboard } from '../../apps/api/src/lib/admin'
import { createFixture, deleteFixture, type TestFixture } from './helpers'

let fixture: TestFixture

beforeEach(async () => {
  fixture = await createFixture({ withBooking: true })
})

afterEach(async () => {
  await deleteFixture(fixture)
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('getDashboard', () => {
  // createFixture builds one seat, marks it BOOKED, and attaches it to a
  // PENDING_PAYMENT booking — so this pins down the exact distinction the
  // two columns make: the seat counts as occupied, the money does not count
  // as revenue.
  it('counts a held-but-unpaid seat as occupied and excludes it from revenue', async () => {
    const row = (await getDashboard()).find((r) => r.showtimeId === fixture.showtimeId)

    expect(row).toBeDefined()
    expect(row!.totalSeats).toBe(1)
    expect(row!.occupiedSeats).toBe(1)
    expect(row!.revenue).toBe(0)
  })

  it('counts a PAID booking as revenue', async () => {
    await prisma.booking.update({
      where: { id: fixture.bookingId },
      data: { status: 'PAID' },
    })

    const row = (await getDashboard()).find((r) => r.showtimeId === fixture.showtimeId)

    expect(row!.revenue).toBeGreaterThan(0)
    expect(row!.occupiedSeats).toBe(1)
  })

  // The failure a mocked test cannot see: joining Seat and Booking in one
  // pass multiplies the rows and inflates both figures.
  it('does not multiply seat counts by booking counts', async () => {
    await prisma.booking.update({ where: { id: fixture.bookingId }, data: { status: 'PAID' } })
    const extra = await prisma.booking.create({
      data: {
        userId: fixture.userIds[1],
        showtimeId: fixture.showtimeId,
        status: 'PAID',
        totalPrice: 1000,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })

    const row = (await getDashboard()).find((r) => r.showtimeId === fixture.showtimeId)

    // Still one seat in this showtime, no matter how many bookings exist.
    expect(row!.totalSeats).toBe(1)
    expect(row!.occupiedSeats).toBe(1)
    expect(row!.revenue).toBe(2000)

    // Scoped to the row this test made — the dev Postgres is shared.
    await prisma.booking.delete({ where: { id: extra.id } })
  })
})
