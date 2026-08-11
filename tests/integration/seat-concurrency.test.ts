import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../../apps/api/src/lib/prisma'
import { closeRedis, getRedis } from '../../apps/api/src/lib/redis'
import { createBooking, SeatUnavailableError } from '../../apps/api/src/lib/booking'

let seatIds: string[] = []
let showtimeId = ''
const userIds: string[] = []

beforeAll(async () => {
  const seatMap = await prisma.seatMap.findFirst({
    include: { seats: { take: 2, orderBy: { id: 'asc' } }, showtime: true },
  })
  if (!seatMap) throw new Error('No seat maps found — run `npx prisma db seed` first')

  showtimeId = seatMap.showtimeId
  seatIds = seatMap.seats.map((s) => s.id)

  // Reset the seats this test uses, so a rerun starts clean.
  await prisma.bookingSeat.deleteMany({ where: { seatId: { in: seatIds } } })
  await prisma.seat.updateMany({ where: { id: { in: seatIds } }, data: { status: 'AVAILABLE' } })
  const redis = await getRedis()
  await redis.del(seatIds.map((id) => `hold:seat:${id}`))

  for (let i = 0; i < 20; i++) {
    const user = await prisma.user.create({
      data: {
        email: `concurrency-${i}-${Date.now()}@example.com`,
        passwordHash: 'x',
        name: `Tester ${i}`,
      },
    })
    userIds.push(user.id)
  }
})

afterAll(async () => {
  await prisma.bookingSeat.deleteMany({ where: { seatId: { in: seatIds } } })
  await prisma.booking.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.seat.updateMany({ where: { id: { in: seatIds } }, data: { status: 'AVAILABLE' } })
  await closeRedis()
  await prisma.$disconnect()
})

describe('two people clicking the same seat at the same time', () => {
  it('produces exactly one booking, however many fire at once', async () => {
    const seatId = seatIds[0]

    // Promise.all, not a loop with await: a sequential loop passes even when
    // the code has a check-then-act race, which is exactly how such a bug
    // reaches production.
    const results = await Promise.allSettled(
      userIds.map((userId) => createBooking({ userId, showtimeId, seatIds: [seatId] })),
    )

    const succeeded = results.filter((r) => r.status === 'fulfilled')
    const failed = results.filter((r) => r.status === 'rejected')

    expect(succeeded).toHaveLength(1)
    expect(failed).toHaveLength(userIds.length - 1)
    for (const f of failed) {
      expect((f as PromiseRejectedResult).reason).toBeInstanceOf(SeatUnavailableError)
    }

    // The database must agree, not just the return values.
    const rows = await prisma.bookingSeat.findMany({ where: { seatId } })
    expect(rows).toHaveLength(1)

    const seat = await prisma.seat.findUniqueOrThrow({ where: { id: seatId } })
    expect(seat.status).toBe('BOOKED')
  })
})
