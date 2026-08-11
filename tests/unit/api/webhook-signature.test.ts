import { describe, it, expect } from 'vitest'
import {
  signWebhookPayload,
  verifyWebhookSignature,
} from '../../../apps/api/src/lib/webhook-signature'

const body = JSON.stringify({ eventId: 'evt_1', outcome: 'succeeded', amount: 4700 })

describe('verifyWebhookSignature', () => {
  it('accepts a signature this module produced', () => {
    expect(verifyWebhookSignature(body, signWebhookPayload(body))).toBe(true)
  })

  it('rejects a wrong signature', () => {
    expect(verifyWebhookSignature(body, 'deadbeef')).toBe(false)
  })

  it('rejects a body altered by a single character after signing', () => {
    const signature = signWebhookPayload(body)
    const tampered = body.replace('4700', '4701')
    expect(verifyWebhookSignature(tampered, signature)).toBe(false)
  })

  it('rejects a missing signature', () => {
    expect(verifyWebhookSignature(body, undefined)).toBe(false)
  })

  it('rejects an empty signature', () => {
    expect(verifyWebhookSignature(body, '')).toBe(false)
  })

  // timingSafeEqual throws on a length mismatch; the helper must not leak that
  // as an exception the route would turn into a 500.
  it('rejects a signature of the wrong length without throwing', () => {
    expect(() => verifyWebhookSignature(body, 'ab')).not.toThrow()
    expect(verifyWebhookSignature(body, 'ab')).toBe(false)
  })

  it('rejects a non-hex signature without throwing', () => {
    expect(() => verifyWebhookSignature(body, 'zzzz')).not.toThrow()
    expect(verifyWebhookSignature(body, 'zzzz')).toBe(false)
  })

  it('signs a Buffer and a string identically', () => {
    expect(signWebhookPayload(Buffer.from(body))).toBe(signWebhookPayload(body))
  })
})
