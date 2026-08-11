import { Router, type RequestHandler } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { signWebhookPayload } from '../lib/webhook-signature.js'
import { API_BASE_URL } from '../lib/config.js'
import { logServerError } from '../lib/log.js'

const router = Router()

const completeSchema = z.object({ outcome: z.enum(['succeeded', 'failed']) })

// Lets the mock payment page show the amount due for a session without
// exposing anything else about the booking or payment row.
export const getSessionHandler: RequestHandler = async (req, res) => {
  const { providerRef } = req.params
  if (typeof providerRef !== 'string') return res.status(400).json({ error: 'Invalid session' })

  try {
    const payment = await prisma.payment.findUnique({ where: { providerRef } })
    if (!payment) return res.status(404).json({ error: 'Session not found' })
    return res.json({ amount: payment.amount })
  } catch (err) {
    logServerError('GET /mock-provider/sessions/:ref failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// Stands in for a payment provider's hosted checkout. It deliberately posts a
// signed webhook over real HTTP rather than calling applyPaymentOutcome
// directly: routing through the wire is the only way the signature check and
// the raw-body handling are actually exercised.
//
// index.ts mounts this router ONLY when PAYMENT_PROVIDER === 'mock', and
// config.assertPaymentProviderIsSafe() refuses to boot with the mock in
// production — this endpoint marks bookings paid with no money involved.
export const completeSessionHandler: RequestHandler = async (req, res) => {
  const { providerRef } = req.params
  if (typeof providerRef !== 'string') return res.status(400).json({ error: 'Invalid session' })

  const parsed = completeSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  try {
    const payment = await prisma.payment.findUnique({ where: { providerRef } })
    if (!payment) return res.status(404).json({ error: 'Session not found' })

    const body = JSON.stringify({
      eventId: `evt_${randomUUID()}`,
      providerRef,
      outcome: parsed.data.outcome,
    })

    const response = await fetch(`${API_BASE_URL}/webhooks/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-payment-signature': signWebhookPayload(body),
      },
      body,
    })

    if (!response.ok) {
      logServerError('mock provider webhook delivery failed', new Error(`status ${response.status}`))
      return res.status(502).json({ error: 'Webhook delivery failed' })
    }

    // bookingId goes back so the payment page can redirect the user to their
    // booking — the page only ever knows the providerRef.
    return res.json({ delivered: true, bookingId: payment.bookingId })
  } catch (err) {
    logServerError('POST /mock-provider/sessions/:ref/complete failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

router.get('/sessions/:providerRef', getSessionHandler)
router.post('/sessions/:providerRef/complete', completeSessionHandler)

export default router
