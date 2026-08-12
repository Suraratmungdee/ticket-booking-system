import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import {
  listVenues,
  createVenue,
  updateVenue,
  listAllEvents,
  createEvent,
  updateEvent,
} from '../lib/admin.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { logServerError } from '../lib/log.js'

const router = Router()

// Prisma throws P2025 when an update targets a row that does not exist, and
// P2003 when a foreign key (venueId, showtimeId, eventId) points at nothing.
// Both mean the caller sent a bad id, not that the server broke.
function isPrismaCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code
}

const venueCreateSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(500),
})
const venueUpdateSchema = venueCreateSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'At least one field must be provided' },
)

export const listVenuesHandler: RequestHandler = async (_req, res) => {
  try {
    return res.json({ venues: await listVenues() })
  } catch (err) {
    logServerError('GET /admin/venues failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

export const createVenueHandler: RequestHandler = async (req, res) => {
  const parsed = venueCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const adminId = req.user?.id
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    return res.status(201).json({ venue: await createVenue(adminId, parsed.data) })
  } catch (err) {
    logServerError('POST /admin/venues failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

export const updateVenueHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' })

  const parsed = venueUpdateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const adminId = req.user?.id
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    return res.json({ venue: await updateVenue(adminId, id, parsed.data) })
  } catch (err) {
    if (isPrismaCode(err, 'P2025')) return res.status(404).json({ error: 'Venue not found' })
    logServerError('PATCH /admin/venues/:id failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

const eventCreateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  venueId: z.string().min(1),
})
const eventUpdateSchema = eventCreateSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'At least one field must be provided' },
)

export const listEventsHandler: RequestHandler = async (_req, res) => {
  try {
    return res.json({ events: await listAllEvents() })
  } catch (err) {
    logServerError('GET /admin/events failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

export const createEventHandler: RequestHandler = async (req, res) => {
  const parsed = eventCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const adminId = req.user?.id
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    return res.status(201).json({ event: await createEvent(adminId, parsed.data) })
  } catch (err) {
    // A venueId that does not exist is the caller's mistake, not ours.
    if (isPrismaCode(err, 'P2003')) return res.status(400).json({ error: 'Unknown venueId' })
    logServerError('POST /admin/events failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

export const updateEventHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' })

  const parsed = eventUpdateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const adminId = req.user?.id
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    return res.json({ event: await updateEvent(adminId, id, parsed.data) })
  } catch (err) {
    if (isPrismaCode(err, 'P2025')) return res.status(404).json({ error: 'Event not found' })
    if (isPrismaCode(err, 'P2003')) return res.status(400).json({ error: 'Unknown venueId' })
    logServerError('PATCH /admin/events/:id failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// requireAuth then requireAdmin on every route, with no exceptions. A route
// added below without both is an unguarded write to the whole catalog.
router.get('/venues', requireAuth, requireAdmin, listVenuesHandler)
router.post('/venues', requireAuth, requireAdmin, createVenueHandler)
router.patch('/venues/:id', requireAuth, requireAdmin, updateVenueHandler)
router.get('/events', requireAuth, requireAdmin, listEventsHandler)
router.post('/events', requireAuth, requireAdmin, createEventHandler)
router.patch('/events/:id', requireAuth, requireAdmin, updateEventHandler)

export default router
