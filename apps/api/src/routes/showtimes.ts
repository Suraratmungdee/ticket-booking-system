import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { getSeatMap } from '../lib/seats.js'
import { createBooking, SeatUnavailableError, TooManySeatsError } from '../lib/booking.js'
import { requireAuth } from '../middleware/auth.js'
import { logServerError } from '../lib/log.js'
import { MAX_SEATS_PER_BOOKING } from '../lib/config.js'

const router = Router()

export const getSeatsHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' })

  try {
    return res.json(await getSeatMap(id))
  } catch (err) {
    logServerError('GET /showtimes/:id/seats failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

router.get('/:id/seats', getSeatsHandler)

const holdSchema = z.object({
  seatIds: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_SEATS_PER_BOOKING)
    // Duplicates would double-count the price and try to lock one seat twice.
    .refine((ids) => new Set(ids).size === ids.length, { message: 'seatIds must be unique' }),
})

export const holdSeatsHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' })

  const parsed = holdSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const booking = await createBooking({ userId, showtimeId: id, seatIds: parsed.data.seatIds })
    return res.status(201).json({
      booking: {
        id: booking.id,
        status: booking.status,
        totalPrice: booking.totalPrice,
        expiresAt: booking.expiresAt,
      },
    })
  } catch (err) {
    if (err instanceof TooManySeatsError) {
      // TooManySeatsError also covers an empty selection (createBooking
      // throws it for < 1 seat too, though the zod schema already blocks
      // that here) — word this for both ends of the range, not just "too many".
      return res
        .status(400)
        .json({ error: `A booking must hold between 1 and ${MAX_SEATS_PER_BOOKING} seats` })
    }
    if (err instanceof SeatUnavailableError) {
      return res.status(409).json({ error: 'One or more seats are no longer available' })
    }
    logServerError('POST /showtimes/:id/seats/hold failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

router.post('/:id/seats/hold', requireAuth, holdSeatsHandler)

export default router
