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

  // The one that matters, and the one unit tests cannot see. Two DIFFERENT
  // eventIds mean the WebhookEvent guard does NOT short-circuit the second
  // delivery — so the Ticket.bookingId unique constraint is the only thing
  // left holding. Drop that index and this test must go red.
  //
  // This test used to be flaky: applyPaymentOutcome read payment.booking
  // .status once and trusted it for the rest of the transaction, so the CAS
  // loser could fall into the recover block on a stale PENDING_PAYMENT read.
  // Whether that produced a clean early-return or a P2002 depended on
  // whether the seat was still AVAILABLE at that point — and createFixture
  // used to leave it AVAILABLE under a PENDING_PAYMENT booking, a state the
  // real createBooking() flow never produces (see helpers.ts). Both bugs are
  // fixed now: the fixture mirrors createBooking's seat-locking, and
  // applyPaymentOutcome locks the Booking row and branches on that instead
  // of the stale read (apps/api/src/lib/payment.ts). See task-7-report.md
  // for the flaky-run data from before this fix.
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
