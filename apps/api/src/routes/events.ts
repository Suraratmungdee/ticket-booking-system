import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { listEvents, getEventById } from '../lib/events.js'
import { logServerError } from '../lib/log.js'

const router = Router()

// Must match exactly what lib/events.ts's dayRange() assumes: a bare
// YYYY-MM-DD string (it interpolates this directly into `${date}T00:00:00.000Z`).
// z.string().refine(Date.parse) was too permissive — it let through full ISO
// timestamps, free-form dates, and bare years, all of which either crash
// dayRange's Date constructor or silently produce the wrong range.
const dateQuerySchema = z.iso.date()

export const listEventsHandler: RequestHandler = async (req, res) => {
  const { date, venueId } = req.query

  if (typeof date === 'string') {
    const parsed = dateQuerySchema.safeParse(date)
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() })
    }
  }

  try {
    const events = await listEvents({
      date: typeof date === 'string' ? date : undefined,
      venueId: typeof venueId === 'string' ? venueId : undefined,
    })
    return res.json({ events })
  } catch (err) {
    logServerError('GET /events failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

router.get('/', listEventsHandler)

export const getEventByIdHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  // req.params.id is typed string | string[] by Express (the array case only
  // applies to wildcard routes like '*id', never ':id') — narrow defensively.
  if (typeof id !== 'string') {
    return res.status(400).json({ error: 'Invalid id' })
  }

  try {
    const event = await getEventById(id)
    if (!event) return res.status(404).json({ error: 'Event not found' })
    return res.json({ event })
  } catch (err) {
    logServerError('GET /events/:id failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

router.get('/:id', getEventByIdHandler)

export default router
