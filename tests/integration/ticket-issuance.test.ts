import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { prisma } from '../../apps/api/src/lib/prisma'
import { applyPaymentOutcome } from '../../apps/api/src/lib/payment'
import { verifyTicketPayload } from '../../apps/api/src/lib/ticket'
import { createFixture, deleteFixture, type TestFixture } from './helpers'

let fixture: TestFixture

beforeEach(async () => {
  fixture = await createFixture({ withBooking: true, withPendingPayment: true })
})

afterEach(async () => {
  // Ticket rows must go before deleteFixture removes the booking they
  // reference, and both are scoped to ids this test created — the local
  // Postgres is shared with every other worktree.
  await prisma.ticket.deleteMany({ where: { bookingId: fixture.bookingId } })
  // Scoped by this run's own bookingId, not a bare 'evt_tkt_' prefix: a
  // prefix match can delete a sibling worktree's rows mid-run (this
  // Postgres is shared), and `evt_tkt_${Date.now()}` can collide across
  // worktrees within the same millisecond. bookingId is a fresh cuid every
  // run, so prefixing with it is enough to scope precisely to this fixture.
  await prisma.webhookEvent.deleteMany({
    where: { eventId: { startsWith: `evt_tkt_${fixture.bookingId}` } },
  })
  await deleteFixture(fixture)
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('ticket issuance', () => {
  it('issues exactly one ticket, in the same transaction as PAID', async () => {
    const result = await applyPaymentOutcome({
      eventId: `evt_tkt_${fixture.bookingId}_seq`,
      providerRef: fixture.providerRef,
      outcome: 'succeeded',
    })

    expect(result.bookingStatus).toBe('PAID')

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: fixture.bookingId } })
    expect(booking.status).toBe('PAID')

    const tickets = await prisma.ticket.findMany({ where: { bookingId: fixture.bookingId } })
    expect(tickets).toHaveLength(1)
    // The signature must cover the id actually written to the row. A unit
    // test can only check what was passed to a mock; this checks the row.
    expect(verifyTicketPayload(tickets[0].qrCodePayload)).toBe(tickets[0].id)
  })

  // CORRECTED CLAIM (final Phase 4 review): this comment used to say
  // dropping Ticket_bookingId_key would turn this test red, and that it
  // reproduces the race Task 7's locked-read fix (3efed72) closed. Neither
  // held up: the reviewer reverted 3efed72 in the working tree and ran the
  // integration suite eight times — 7/7 green every run. What actually
  // happens with Promise.allSettled here is that the two applyPaymentOutcome
  // calls do not overlap in the window that matters: whichever transaction
  // gets the Booking row lock (FOR UPDATE) first runs to completion and
  // commits PAID well before the second transaction's locked read executes,
  // so the loser simply reads an already-committed PAID status and takes the
  // early return at the top of applyPaymentOutcome. Ticket.bookingId's
  // unique constraint is never exercised by this test.
  //
  // What this test DOES cover: applying two distinct successful deliveries
  // (different eventIds, so the WebhookEvent guard does not short-circuit
  // either one) is idempotent on the happy path — exactly one ticket, the
  // booking ends up PAID, regardless of which call Node happens to schedule
  // first. That is a real and worth-having guarantee; it is just not a
  // concurrency test.
  //
  // What DOES protect the locked-read fix: the unit test 'branches on the
  // row-locked booking status, not the stale nested payment.booking.status'
  // in tests/unit/api/payment.test.ts, which mocks the row-lock query
  // directly and asserts the code branches on ITS result rather than on
  // payment.booking.status. Making an integration test truly schedule two
  // real transactions into the overlapping window was attempted and is
  // genuinely hard to do deterministically — left undone rather than shipped
  // as a slow test that still wouldn't reliably hit the race. See
  // task-7-report.md for the flaky-run data from before 3efed72.
  it('issues one ticket when two distinct successes land at once', async () => {
    const results = await Promise.allSettled([
      applyPaymentOutcome({
        eventId: `evt_tkt_${fixture.bookingId}_a`,
        providerRef: fixture.providerRef,
        outcome: 'succeeded',
      }),
      applyPaymentOutcome({
        eventId: `evt_tkt_${fixture.bookingId}_b`,
        providerRef: fixture.providerRef,
        outcome: 'succeeded',
      }),
    ])

    // Neither call may blow up — a P2002 escaping issueTicket would surface
    // to the provider as a 500 and trigger an endless retry.
    for (const r of results) expect(r.status).toBe('fulfilled')

    const tickets = await prisma.ticket.findMany({ where: { bookingId: fixture.bookingId } })
    expect(tickets).toHaveLength(1)

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: fixture.bookingId } })
    expect(booking.status).toBe('PAID')
  })

  it('issues no ticket when the payment fails', async () => {
    await applyPaymentOutcome({
      eventId: `evt_tkt_${fixture.bookingId}_fail`,
      providerRef: fixture.providerRef,
      outcome: 'failed',
    })

    expect(await prisma.ticket.count({ where: { bookingId: fixture.bookingId } })).toBe(0)
  })
})
