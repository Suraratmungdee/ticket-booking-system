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
// A duplicate webhook delivery loses to bookingId's unique constraint and
// returns quietly. Reading first and inserting only if absent would be a
// check-then-act race — two parallel deliveries would both see nothing.
export async function issueTicket(
  tx: Prisma.TransactionClient,
  bookingId: string,
): Promise<void> {
  const id = randomUUID()
  try {
    await tx.ticket.create({
      data: { id, bookingId, qrCodePayload: signTicketPayload(id) },
    })
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002') return
    throw err
  }
}
