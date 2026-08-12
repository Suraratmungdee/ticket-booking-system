import type { RequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import { JWT_SECRET, JWT_COOKIE_NAME } from '../lib/config.js'
import { prisma } from '../lib/prisma.js'

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; role: string }
    }
  }
}

// Verifies the httpOnly JWT cookie issued by POST /auth/login. Every reply is
// the same opaque 401 whether the cookie is missing, malformed, expired, or
// forged — a caller learns nothing about why.
export const requireAuth: RequestHandler = (req, res, next) => {
  const token = req.cookies?.[JWT_COOKIE_NAME]
  if (typeof token !== 'string') {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET)
    if (typeof payload === 'string' || typeof payload.sub !== 'string') {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    req.user = { id: payload.sub, role: String(payload.role ?? 'USER') }
    return next()
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
}

// Always mounted AFTER requireAuth, which puts the caller on req.user.
//
// The role comes from the database, not from req.user.role (which came from
// the JWT). A token lives for JWT_MAX_AGE_MS — two hours — so trusting its
// role claim would let someone whose admin rights were revoked keep writing
// to every table for the rest of that window. One extra query, only on
// /admin routes, buys immediate revocation.
export const requireAdmin: RequestHandler = async (req, res, next) => {
  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  })

  // 404, not 403: a 403 would confirm to a normal user that these routes
  // exist at all. Same rule the booking and ticket routes follow.
  if (!user || user.role !== 'ADMIN') {
    return res.status(404).json({ error: 'Not found' })
  }

  return next()
}
