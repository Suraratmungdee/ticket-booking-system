import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// Module-scoped and hoisted above the imports below, so every call to
// acquireSeatHolds in this file always succeeds — the Redis fast-path gate
// never rejects anyone, and all 20 calls actually reach
// `prisma.$transaction` and genuinely race on `SELECT ... FOR UPDATE OF s`.
// vi.mock can't be scoped to a subset of tests in one file, which is why
// this lives in its own file rather than next to the full-stack test.
vi.mock('../../apps/api/src/lib/seat-lock.js', () => ({
  acquireSeatHolds: async () => true,
  releaseSeatHolds: async () => {},
  getHeldSeatIds: async () => new Set<string>(),
}))

import { prisma } from '../../apps/api/src/lib/prisma'
import { closeRedis } from '../../apps/api/src/lib/redis'
import { createBooking, SeatUnavailableError } from '../../apps/api/src/lib/booking'
import { createFixture, deleteFixture, type TestFixture } from './helpers'

let fixture: TestFixture

beforeAll(async () => {
  fixture = await createFixture('redis-bypassed')
})

afterAll(async () => {
  await deleteFixture(fixture)
  await closeRedis()
  await prisma.$disconnect()
})

describe('two people clicking the same seat at the same time (Redis gate bypassed)', () => {
  it('still yields exactly one winner when the Redis gate is bypassed — proving Postgres is the authority', async () => {
    const { seatId, showtimeId, userIds } = fixture

    // With the Redis gate mocked to always succeed, all 20 calls genuinely
    // reach `prisma.$transaction` and contend `SELECT ... FOR UPDATE OF s`
    // at the same time. This is the case that actually matters: if Redis is
    // unavailable or wrong, booking must still be correct — that is the
    // spec's central design claim, and until this test existed it was
    // unverified.
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
