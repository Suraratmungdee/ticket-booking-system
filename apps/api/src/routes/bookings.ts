import { Router, type RequestHandler } from 'express'
import { getBookingForUser } from '../lib/booking.js'
import { requireAuth } from '../middleware/auth.js'
import { logServerError } from '../lib/log.js'

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

router.get('/:id', requireAuth, getBookingHandler)

export default router
