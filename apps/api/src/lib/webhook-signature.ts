import { createHmac, timingSafeEqual } from 'node:crypto'
import { PAYMENT_WEBHOOK_SECRET } from './config.js'

// HMAC-SHA256 over the exact bytes that were transmitted. It must be the raw
// body, never a re-serialized object: re-stringifying can reorder keys or
// change whitespace, and the signature would then never match.
export function signWebhookPayload(rawBody: string | Buffer): string {
  return createHmac('sha256', PAYMENT_WEBHOOK_SECRET).update(rawBody).digest('hex')
}

export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string | undefined,
): boolean {
  if (!signature) return false
  // Buffer.from stops decoding at the first invalid hex pair rather than
  // rejecting the whole string, so e.g. a correct 64-char signature with
  // garbage appended would decode to the same bytes as the correct one and
  // pass. Require the full string to be exactly 64 lowercase/uppercase hex
  // characters (one SHA-256 digest) before decoding at all.
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false

  const expected = Buffer.from(signWebhookPayload(rawBody), 'hex')
  // Buffer.from silently drops invalid hex characters rather than throwing,
  // so a garbage signature becomes a short buffer — the length check below
  // catches it, and timingSafeEqual is never handed mismatched lengths.
  const provided = Buffer.from(signature, 'hex')
  if (provided.length !== expected.length) return false

  return timingSafeEqual(provided, expected)
}
