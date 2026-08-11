import type { RequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import { JWT_SECRET, JWT_COOKIE_NAME } from '../lib/config.js'

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
