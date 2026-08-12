import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import {
  listVenues,
  createVenue,
  updateVenue,
  listAllEvents,
  createEvent,
  updateEvent,
  createShowtime,
  updateShowtime,
  createSeatMap,
  SeatMapTooLargeError,
  listBookings,
  getDashboard,
} from '../lib/admin.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { logServerError } from '../lib/log.js'
import { MAX_SEATS_PER_SEATMAP } from '../lib/config.js'

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

const showtimeCreateSchema = z
  .object({
    eventId: z.string().min(1),
    startTime: z.iso.datetime(),
    endTime: z.iso.datetime(),
  })
  .refine((v) => new Date(v.endTime) > new Date(v.startTime), {
    message: 'endTime must be after startTime',
  })

export const createShowtimeHandler: RequestHandler = async (req, res) => {
  const parsed = showtimeCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const adminId = req.user?.id
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const showtime = await createShowtime(adminId, {
      eventId: parsed.data.eventId,
      startTime: new Date(parsed.data.startTime),
      endTime: new Date(parsed.data.endTime),
    })
    return res.status(201).json({ showtime })
  } catch (err) {
    if (isPrismaCode(err, 'P2003')) return res.status(400).json({ error: 'Unknown eventId' })
    logServerError('POST /admin/showtimes failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

const showtimeUpdateSchema = z
  .object({ startTime: z.iso.datetime().optional(), endTime: z.iso.datetime().optional() })
  .refine((v) => v.startTime !== undefined || v.endTime !== undefined, {
    message: 'At least one field must be provided',
  })

export const updateShowtimeHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' })

  const parsed = showtimeUpdateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const adminId = req.user?.id
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const showtime = await updateShowtime(adminId, id, {
      ...(parsed.data.startTime ? { startTime: new Date(parsed.data.startTime) } : {}),
      ...(parsed.data.endTime ? { endTime: new Date(parsed.data.endTime) } : {}),
    })
    return res.json({ showtime })
  } catch (err) {
    if (isPrismaCode(err, 'P2025')) return res.status(404).json({ error: 'Showtime not found' })
    logServerError('PATCH /admin/showtimes/:id failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

const seatMapCreateSchema = z.object({
  showtimeId: z.string().min(1),
  zoneName: z.string().min(1).max(100),
  // Whole baht. int() rejects 149.5, which would silently become a Float
  // price and break every total in the system.
  price: z.number().int().nonnegative(),
  // Duplicate labels (e.g. ['A', 'A']) would make createSeatMap generate two
  // { row: 'A', number: 1 } seats, tripping the @@unique([seatMapId, row,
  // number]) constraint as a raw P2002 instead of a clear 400. Rejected here
  // so the request never reaches the database.
  rows: z
    .array(z.string().min(1).max(4))
    .min(1)
    .refine((rows) => new Set(rows).size === rows.length, {
      message: 'rows must not contain duplicate labels',
    }),
  seatsPerRow: z.number().int().positive(),
})

export const createSeatMapHandler: RequestHandler = async (req, res) => {
  const parsed = seatMapCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  const adminId = req.user?.id
  if (!adminId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    return res.status(201).json({ seatMap: await createSeatMap(adminId, parsed.data) })
  } catch (err) {
    if (err instanceof SeatMapTooLargeError) {
      return res
        .status(400)
        .json({ error: `A seat map may contain at most ${MAX_SEATS_PER_SEATMAP} seats` })
    }
    if (isPrismaCode(err, 'P2003')) return res.status(400).json({ error: 'Unknown showtimeId' })
    // seatMapCreateSchema's rows.refine rejects duplicate row labels up
    // front, so a duplicate (seatMapId, row, number) is not expected to
    // reach the database. P2002 is deliberately left unhandled here rather
    // than caught: if it ever surfaces, that means the schema's guard was
    // bypassed or missed a case, and it should show up as a loud 500, not be
    // swallowed. Never catch a constraint error and continue inside a
    // transaction: Postgres has already aborted it.
    logServerError('POST /admin/seatmaps failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// Mirrors the BookingStatus enum in schema.prisma. An unknown value is the
// caller's mistake, not an empty result set that looks like "no bookings".
const bookingStatusSchema = z.enum([
  'PENDING_PAYMENT',
  'PAID',
  'EXPIRED',
  'CANCELLED',
  'REFUND_REQUIRED',
])

export const listBookingsHandler: RequestHandler = async (req, res) => {
  const { status, email } = req.query

  if (typeof status === 'string') {
    const parsed = bookingStatusSchema.safeParse(status)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  }

  try {
    const bookings = await listBookings({
      status: typeof status === 'string' ? status : undefined,
      email: typeof email === 'string' ? email : undefined,
    })
    return res.json({ bookings })
  } catch (err) {
    logServerError('GET /admin/bookings failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

export const dashboardHandler: RequestHandler = async (_req, res) => {
  try {
    return res.json({ showtimes: await getDashboard() })
  } catch (err) {
    logServerError('GET /admin/dashboard failed', err)
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
router.post('/showtimes', requireAuth, requireAdmin, createShowtimeHandler)
router.patch('/showtimes/:id', requireAuth, requireAdmin, updateShowtimeHandler)
router.post('/seatmaps', requireAuth, requireAdmin, createSeatMapHandler)
router.get('/bookings', requireAuth, requireAdmin, listBookingsHandler)
router.get('/dashboard', requireAuth, requireAdmin, dashboardHandler)

export default router
