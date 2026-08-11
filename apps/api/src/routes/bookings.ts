import { Router, type RequestHandler } from 'express'
import { getBookingForUser } from '../lib/booking.js'
import { createCheckoutSession, BookingNotPayableError } from '../lib/payment.js'
import { requireAuth } from '../middleware/auth.js'
import { logServerError } from '../lib/log.js'
import { PAYMENT_PROVIDER, FRONTEND_ORIGIN } from '../lib/config.js'

const router = Router()

export const getBookingHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' })

  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const booking = await getBookingForUser(id, userId)
    // 404 rather than 403 for someone else's booking: a 403 would confirm the
    // id exists, letting a caller enumerate bookings.
    if (!booking) return res.status(404).json({ error: 'Booking not found' })
    return res.json({ booking })
  } catch (err) {
    logServerError('GET /bookings/:id failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

export const checkoutHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' })

  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const session = await createCheckoutSession(id, userId)
    return res.status(201).json({
      providerRef: session.providerRef,
      amount: session.amount,
      // Where the user goes to pay. With a real provider this would be the
      // provider's hosted page; the mock's stands in for it.
      checkoutUrl: `${FRONTEND_ORIGIN}/mock-pay/${session.providerRef}`,
      provider: PAYMENT_PROVIDER,
    })
  } catch (err) {
    // Covers "not yours", "not pending", and "hold expired" alike — the
    // caller learns only that it cannot be paid, not which of those it is.
    if (err instanceof BookingNotPayableError) {
      return res.status(409).json({ error: 'This booking cannot be paid for' })
    }
    logServerError('POST /bookings/:id/checkout failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

router.get('/:id', requireAuth, getBookingHandler)
router.post('/:id/checkout', requireAuth, checkoutHandler)

export default router
