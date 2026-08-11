import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../../apps/api/src/lib/prisma'
import { closeRedis } from '../../apps/api/src/lib/redis'
import { createBooking, SeatUnavailableError } from '../../apps/api/src/lib/booking'
import { createFixture, deleteFixture, type TestFixture } from './helpers'

let fixture: TestFixture

beforeAll(async () => {
  fixture = await createFixture('full-stack')
})

afterAll(async () => {
  await deleteFixture(fixture)
  await closeRedis()
  await prisma.$disconnect()
})

describe('two people clicking the same seat at the same time (full stack)', () => {
  it('rejects contenders at the Redis gate (full stack)', async () => {
    const { seatId, showtimeId, userIds } = fixture

    // Promise.allSettled, not a loop with await: a sequential loop passes
    // even when the code has a check-then-act race, which is exactly how
    // such a bug reaches production.
    //
    // What this proves: `acquireSeatHolds`'s `SET NX` on the shared Redis
    // key `hold:seat:{seatId}` is what actually decides the winner here —
    // Redis executes commands serially, so of these 20 concurrent calls
    // exactly one `SET NX` returns 'OK' and the other 19 throw
    // `SeatUnavailableError` before `prisma.$transaction` is ever entered.
    // Only the Redis winner reaches Postgres, so this test alone does NOT
    // exercise the `FOR UPDATE` row lock — see
    // seat-concurrency-redis-bypassed.test.ts for that.
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
