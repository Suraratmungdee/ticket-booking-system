import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { TICKET_SIGNING_SECRET } from './config.js'

// The QR carries "<ticketId>.<hmac>" so a scanner can tell a forged code
// from a real one without a database round-trip. Signed with a secret
// distinct from the payment webhook's — see config.ts.
export function signTicketPayload(ticketId: string): string {
  const signature = createHmac('sha256', TICKET_SIGNING_SECRET).update(ticketId).digest('hex')
  return `${ticketId}.${signature}`
}

// Returns the ticketId when the signature is ours, null otherwise. Every
// rejection returns the same null — the caller learns nothing about which
// part was wrong.
export function verifyTicketPayload(payload: string): string | null {
  const parts = payload.split('.')
  // Exactly two parts. A ticket id never contains a dot, so anything else
  // was assembled by someone other than us.
  if (parts.length !== 2) return null
  const [ticketId, signature] = parts
  if (!ticketId || !signature) return null

  // Validate the whole string as hex BEFORE decoding. Buffer.from stops at
  // the first invalid pair rather than rejecting, so a correct 64-char
  // signature with garbage appended would otherwise decode to the same
  // bytes and pass. This is the bug webhook-signature.ts already had to fix.
  if (!/^[0-9a-f]{64}$/i.test(signature)) return null

  const expected = Buffer.from(
    createHmac('sha256', TICKET_SIGNING_SECRET).update(ticketId).digest('hex'),
    'hex',
  )
  const provided = Buffer.from(signature, 'hex')
  // timingSafeEqual throws on mismatched lengths; the regex above already
  // guarantees they match, but this does not rely on that alone.
  if (provided.length !== expected.length) return null

  return timingSafeEqual(provided, expected) ? ticketId : null
}

// Issues the single ticket for a booking. Called inside the same
// transaction that moves the booking to PAID, so "PAID" and "has a ticket"
// can never disagree.
//
// The id is generated here rather than left to @default(cuid()): the
// payload signs the id, so the id has to exist before the row is written.
//
// A duplicate webhook delivery collides with bookingId's unique constraint
// and P2002 is deliberately left UNCAUGHT — do not add a try/catch back.
// Postgres aborts the whole transaction the instant that constraint is
// violated; Prisma does not give each statement its own savepoint. Catching
// P2002 here and returning normally would not resume the transaction — the
// booking/payment/webhookEvent writes made earlier in this same transaction
// would all silently roll back at COMMIT while the caller believes it
// succeeded, which is worse than doing nothing: the webhook would answer
// 200, the provider would stop retrying, and the booking would be stuck at
// PENDING_PAYMENT with the customer already charged and no REFUND_REQUIRED
// flag to catch it. Letting it throw aborts the transaction honestly and
// the webhook route returns 500, so the provider retries and the second
// attempt (a fresh transaction, ticket already present) can decide again.
//
// This is NOT the same situation as the webhookEvent.create P2002 swallow
// at the top of applyPaymentOutcome in payment.ts — that one is safe only
// because it is the FIRST statement in the transaction, so there is nothing
// preceding it that a rollback would discard. issueTicket runs after the
// booking/payment writes, so the same pattern here would erase them.
export async function issueTicket(
  tx: Prisma.TransactionClient,
  bookingId: string,
): Promise<void> {
  const id = randomUUID()
  await tx.ticket.create({
    data: { id, bookingId, qrCodePayload: signTicketPayload(id) },
  })
}
