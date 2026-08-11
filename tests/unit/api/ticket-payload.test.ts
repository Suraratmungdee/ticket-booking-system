import { describe, it, expect } from 'vitest'
import { signTicketPayload, verifyTicketPayload } from '../../../apps/api/src/lib/ticket'

describe('ticket payload signing', () => {
  it('round-trips a ticket id', () => {
    const payload = signTicketPayload('tkt_abc')
    expect(verifyTicketPayload(payload)).toBe('tkt_abc')
  })

  it('produces id.signature with a 64-hex signature', () => {
    const payload = signTicketPayload('tkt_abc')
    const [id, sig] = payload.split('.')
    expect(id).toBe('tkt_abc')
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a payload whose ticket id was swapped', () => {
    const payload = signTicketPayload('tkt_abc')
    const sig = payload.split('.')[1]
    expect(verifyTicketPayload(`tkt_someone_elses.${sig}`)).toBeNull()
  })

  it('rejects a tampered signature', () => {
    const payload = signTicketPayload('tkt_abc')
    const [id, sig] = payload.split('.')
    const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1)
    expect(verifyTicketPayload(`${id}.${flipped}`)).toBeNull()
  })

  // The exact bug Phase 3 shipped and had to fix in webhook-signature.ts:
  // Buffer.from(hex) stops decoding at the first invalid pair instead of
  // throwing, so a valid signature with garbage appended decodes to the
  // same bytes and passes unless the whole string is validated first.
  it('rejects a valid signature with garbage appended', () => {
    const payload = signTicketPayload('tkt_abc')
    expect(verifyTicketPayload(`${payload}zzzz`)).toBeNull()
  })

  it('rejects a payload with no separator', () => {
    expect(verifyTicketPayload('tkt_abc')).toBeNull()
  })

  it('rejects an empty payload', () => {
    expect(verifyTicketPayload('')).toBeNull()
  })

  // A ticket id may not contain a dot, so extra dots mean the payload was
  // assembled by someone other than us.
  it('rejects a payload with extra separators', () => {
    const payload = signTicketPayload('tkt_abc')
    expect(verifyTicketPayload(`extra.${payload}`)).toBeNull()
  })
})
