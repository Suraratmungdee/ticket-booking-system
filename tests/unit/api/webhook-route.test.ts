import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ apply: vi.fn() }))
vi.mock('../../../apps/api/src/lib/payment', () => ({ applyPaymentOutcome: m.apply }))

import { paymentWebhookHandler } from '../../../apps/api/src/routes/webhooks'
import { signWebhookPayload } from '../../../apps/api/src/lib/webhook-signature'

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() } as any
  res.status.mockReturnValue(res)
  res.json.mockReturnValue(res)
  return res
}

function makeReq(body: Buffer, signature?: string) {
  return { body, header: (name: string) => (name === 'x-payment-signature' ? signature : undefined) } as any
}

const payload = { eventId: 'evt_1', providerRef: 'ref_1', outcome: 'succeeded' as const }
const raw = Buffer.from(JSON.stringify(payload))

beforeEach(() => {
  vi.clearAllMocks()
  m.apply.mockResolvedValue({ applied: true })
})

describe('paymentWebhookHandler', () => {
  it('rejects a request with no signature and never touches the payment layer', async () => {
    const res = makeRes()
    await paymentWebhookHandler(makeReq(raw), res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(m.apply).not.toHaveBeenCalled()
  })

  it('rejects a forged signature', async () => {
    const res = makeRes()
    await paymentWebhookHandler(makeReq(raw, 'deadbeef'), res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(m.apply).not.toHaveBeenCalled()
  })

  // Signed one payload, sent another.
  it('rejects a body altered after signing', async () => {
    const signature = signWebhookPayload(raw)
    const tampered = Buffer.from(JSON.stringify({ ...payload, outcome: 'failed' }))
    const res = makeRes()

    await paymentWebhookHandler(makeReq(tampered, signature), res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(m.apply).not.toHaveBeenCalled()
  })

  it('accepts a correctly signed payload', async () => {
    const res = makeRes()
    await paymentWebhookHandler(makeReq(raw, signWebhookPayload(raw)), res, vi.fn())

    expect(m.apply).toHaveBeenCalledWith(payload)
    expect(res.json).toHaveBeenCalledWith({ received: true, applied: true })
  })

  it('returns 200 for a duplicate event rather than a retryable error', async () => {
    m.apply.mockResolvedValue({ applied: false })
    const res = makeRes()

    await paymentWebhookHandler(makeReq(raw, signWebhookPayload(raw)), res, vi.fn())

    expect(res.status).not.toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ received: true, applied: false })
  })
})
