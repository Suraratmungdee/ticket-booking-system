import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { prisma } from '../../apps/api/src/lib/prisma'
import { applyPaymentOutcome } from '../../apps/api/src/lib/payment'
import { createFixture, deleteFixture, type TestFixture } from './helpers'

let fixture: TestFixture

beforeEach(async () => {
  fixture = await createFixture({ withBooking: true, withPendingPayment: true })
})

afterEach(async () => {
  await prisma.webhookEvent.deleteMany({ where: { eventId: { startsWith: 'evt_test_' } } })
  await deleteFixture(fixture)
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('webhook idempotency', () => {
  it('applies a repeated delivery exactly once', async () => {
    const eventId = `evt_test_${Date.now()}_seq`
    const input = { eventId, providerRef: fixture.providerRef, outcome: 'succeeded' as const }

    const first = await applyPaymentOutcome(input)
    const paidAtAfterFirst = (
      await prisma.payment.findUniqueOrThrow({ where: { providerRef: fixture.providerRef } })
    ).paidAt

    const second = await applyPaymentOutcome(input)

    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { providerRef: fixture.providerRef },
    })
    expect(payment.status).toBe('SUCCEEDED')
    // A second application would stamp a new time.
    expect(payment.paidAt?.getTime()).toBe(paidAtAfterFirst?.getTime())

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: fixture.bookingId } })
    expect(booking.status).toBe('PAID')
    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(1)
  })

  // The one that matters. What this actually pins down is the unique index
  // on WebhookEvent.eventId, not the INSERT-vs-SELECT-then-INSERT wording in
  // applyPaymentOutcome: with the constraint in place and the insert inside
  // the same transaction as the effect, either form is race-safe (a losing
  // INSERT still throws, still rolls back that transaction's effect) —
  // confirmed by mutating applyPaymentOutcome to SELECT-then-INSERT, which
  // left both this test and the sequential one green (see task-6-report.md).
  // The mutation that is expected to actually break this one is dropping the
  // index itself (`DROP INDEX "WebhookEvent_eventId_key"`, then restore with
  // `CREATE UNIQUE INDEX ... ON "WebhookEvent"("eventId")`) — see
  // task-6-report.md for that run's real numbers. A migration that drops,
  // renames, or fails to recreate that index is the regression this test
  // exists to catch — the same blind spot that let a broken rate limiter and
  // a mis-targeted concurrency test through in earlier phases.
  it('applies exactly once when the same event arrives ten times at once', async () => {
    const eventId = `evt_test_${Date.now()}_par`
    const input = { eventId, providerRef: fixture.providerRef, outcome: 'succeeded' as const }

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => applyPaymentOutcome(input)),
    )

    const applied = results.filter((r) => r.status === 'fulfilled' && r.value.applied === true)
    expect(applied).toHaveLength(1)

    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(1)

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: fixture.bookingId } })
    expect(booking.status).toBe('PAID')

    const payments = await prisma.payment.findMany({ where: { bookingId: fixture.bookingId } })
    expect(payments).toHaveLength(1)
    expect(payments[0].status).toBe('SUCCEEDED')
  })
})
