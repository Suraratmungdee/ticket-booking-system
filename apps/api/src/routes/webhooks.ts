import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { verifyWebhookSignature } from '../lib/webhook-signature.js'
import { applyPaymentOutcome, PaymentNotFoundError } from '../lib/payment.js'
import { notifyBookingPaid } from '../lib/email.js'
import { logServerError } from '../lib/log.js'

const router = Router()

const payloadSchema = z.object({
  eventId: z.string().min(1),
  providerRef: z.string().min(1),
  outcome: z.enum(['succeeded', 'failed']),
})

export const paymentWebhookHandler: RequestHandler = async (req, res) => {
  // req.body is a Buffer here — express.raw is mounted for this path in
  // index.ts, ahead of express.json. The signature covers the exact bytes
  // that arrived, so it must be checked before anything parses them.
  const rawBody: Buffer = req.body
  const signature = req.header('x-payment-signature')

  if (!Buffer.isBuffer(rawBody) || !verifyWebhookSignature(rawBody, signature)) {
    // Nothing is read from or written to the database on this path.
    return res.status(400).json({ error: 'Invalid signature' })
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawBody.toString('utf8'))
  } catch {
    return res.status(400).json({ error: 'Invalid payload' })
  }

  const parsed = payloadSchema.safeParse(parsedJson)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  try {
    const result = await applyPaymentOutcome(parsed.data)

    // After the transaction has committed, never inside it: an HTTP call to
    // a mail provider must not hold a seat-row lock open. Fire-and-forget
    // because the ticket is already in the database and visible at
    // /me/tickets — a mail outage must not turn a completed payment into a
    // 500 that the provider then retries forever.
    //
    // Guard on `transitioned`, not `bookingStatus === 'PAID'`: a re-delivery
    // of an already-applied success under a *different* eventId (normal for
    // at-least-once delivery) also returns bookingStatus 'PAID' — the same
    // shape a genuine first transition returns. `applied` only dedupes a
    // repeated identical eventId (the WebhookEvent unique constraint), not
    // this case. `transitioned` is true only on the two paths in
    // applyPaymentOutcome that actually move a booking into PAID for the
    // first time, so it is the one flag that will not re-send the email on
    // every re-delivery a payment provider makes.
    if (result.transitioned && result.bookingId) {
      void notifyBookingPaid(result.bookingId).catch((err) =>
        logServerError('confirmation email failed', err),
      )
    }

    // 200 even when the event was a duplicate: a provider retries on any
    // non-2xx, and re-delivering something already handled helps nobody.
    return res.json({ received: true, applied: result.applied })
  } catch (err) {
    logServerError('POST /webhooks/payment failed', err)
    // An unknown providerRef will never start existing on retry — a 500 here
    // would make a real provider retry this forever. 400 tells it to stop.
    if (err instanceof PaymentNotFoundError) {
      return res.status(400).json({ error: 'Invalid payload' })
    }
    return res.status(500).json({ error: 'Internal server error' })
  }
}

router.post('/payment', paymentWebhookHandler)

export default router
