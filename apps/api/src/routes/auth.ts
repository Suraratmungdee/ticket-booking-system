import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import {
  registerUser,
  loginUser,
  InvalidCredentialsError,
  EmailAlreadyRegisteredError,
} from '../lib/auth.js'
import { JWT_COOKIE_NAME, JWT_MAX_AGE_MS, COOKIE_SAME_SITE, COOKIE_SECURE } from '../lib/config.js'
import { logServerError } from '../lib/log.js'
import { isRateLimited, recordLoginFailure, refundAttempt } from '../lib/rate-limit.js'

const router = Router()

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
})

// Exported (not just mounted) so unit tests can call it directly with a
// fake req/res, without adding an HTTP test dependency like supertest.
export const registerHandler: RequestHandler = async (req, res) => {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }

  try {
    const user = await registerUser(parsed.data)
    return res.status(201).json({ user })
  } catch (err) {
    // registerUser's existence check and create() aren't atomic, so a
    // concurrent duplicate registration surfaces as a raw Prisma unique
    // constraint violation (P2002) instead of EmailAlreadyRegisteredError.
    // Treat both as the same 409 the client sees for a taken email.
    if (
      err instanceof EmailAlreadyRegisteredError ||
      (typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'P2002')
    ) {
      return res.status(409).json({ error: 'Email already registered' })
    }
    logServerError('POST /auth/register failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

router.post('/register', registerHandler)

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

// Exported (not just mounted) so unit tests can call it directly, same
// pattern as registerHandler above.
export const loginHandler: RequestHandler = async (req, res) => {
  // req.ip is undefined when there's no usable socket to read an address
  // from — a destroyed/aborted connection in production, not just test
  // fakes — fall back to a fixed key so those still share one bucket
  // rather than crash.
  const key = req.ip ?? 'unknown'
  if (isRateLimited(key)) {
    return res.status(429).json({ error: 'Too many login attempts. Please try again later.' })
  }

  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }

  // Reserve budget synchronously, before the `await` below — not after it
  // resolves. Incrementing only post-await let every request in a
  // concurrent burst read the same pre-increment count and slip through
  // the gate for free (the count-then-act race); reserving here closes
  // that because it happens in the same synchronous tick as the
  // isRateLimited() check above, before this call can be interleaved with
  // any other. Refunded below if the login actually succeeds.
  recordLoginFailure(key)

  try {
    const { token, user } = await loginUser(parsed.data)
    refundAttempt(key)
    res.cookie(JWT_COOKIE_NAME, token, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: COOKIE_SAME_SITE,
      maxAge: JWT_MAX_AGE_MS,
    })
    return res.json({ user })
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      // Genuine failed guess — keep the reservation made above.
      return res.status(401).json({ error: 'Invalid email or password' })
    }
    // Not a credential guess (e.g. a DB error) — don't charge it against
    // the login budget.
    refundAttempt(key)
    logServerError('POST /auth/login failed', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

router.post('/login', loginHandler)

export default router
