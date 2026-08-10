import { Router } from 'express'
import { z } from 'zod'
import {
  registerUser,
  loginUser,
  InvalidCredentialsError,
  EmailAlreadyRegisteredError,
} from '../lib/auth.js'
import { JWT_COOKIE_NAME } from '../lib/config.js'

const router = Router()

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
})

router.post('/register', async (req, res) => {
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
    console.error(err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }

  try {
    const { token, user } = await loginUser(parsed.data)
    res.cookie(JWT_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 2 * 60 * 60 * 1000,
    })
    return res.json({ user })
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }
    console.error(err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
