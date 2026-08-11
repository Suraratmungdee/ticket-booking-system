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

  const expected = Buffer.from(signWebhookPayload(rawBody), 'hex')
  // Buffer.from silently drops invalid hex characters rather than throwing,
  // so a garbage signature becomes a short buffer — the length check below
  // catches it, and timingSafeEqual is never handed mismatched lengths.
  const provided = Buffer.from(signature, 'hex')
  if (provided.length !== expected.length) return false

  return timingSafeEqual(provided, expected)
}
