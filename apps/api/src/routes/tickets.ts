import { Router, type RequestHandler } from 'express'
import QRCode from 'qrcode'
import { listTicketsForUser, getTicketForUser } from '../lib/ticket.js'
import { requireAuth } from '../middleware/auth.js'
import { logServerError } from '../lib/log.js'

export const listMyTicketsHandler: RequestHandler = async (req, res) => {
  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const tickets = await listTicketsForUser(userId)
    // listTicketsForUser selects columns explicitly and omits
    // qrCodePayload — see the comment on it in lib/ticket.ts.
    return res.json({ tickets })
  } catch (err) {
    logServerError('GET /me/tickets failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

export const getTicketHandler: RequestHandler = async (req, res) => {
  const { id } = req.params
  if (typeof id !== 'string') return res.status(400).json({ error: 'Invalid id' })

  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const ticket = await getTicketForUser(id, userId)
    // 404 rather than 403 for someone else's ticket: a 403 would confirm
    // the id exists, letting a caller enumerate tickets.
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' })

    // Rendered here so the browser never has to know what the payload means.
    const qrDataUrl = await QRCode.toDataURL(ticket.qrCodePayload, { margin: 1, width: 320 })
    return res.json({ ticket: { ...ticket, qrDataUrl } })
  } catch (err) {
    logServerError('GET /tickets/:id failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

const router = Router()
router.get('/:id', requireAuth, getTicketHandler)

// Mounted at /me, so this is GET /me/tickets. Same file as the handler it
// shares a query layer with — splitting it into a second route file to
// satisfy the URL prefix would spread one concern across two places.
export const meTicketsRouter = Router()
meTicketsRouter.get('/tickets', requireAuth, listMyTicketsHandler)

export default router
