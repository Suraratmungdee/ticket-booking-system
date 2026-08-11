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

  // The one that matters. A sequential duplicate check passes even when
  // idempotency is a SELECT-then-INSERT, because each call finishes before the
  // next begins — the same blind spot that let a broken rate limiter and a
  // mis-targeted concurrency test through in earlier phases.
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
