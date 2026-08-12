import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import authRouter from './routes/auth.js'
import eventsRouter from './routes/events.js'
import showtimesRouter from './routes/showtimes.js'
import bookingsRouter from './routes/bookings.js'
import webhooksRouter from './routes/webhooks.js'
import ticketsRouter, { meTicketsRouter } from './routes/tickets.js'
import adminRouter from './routes/admin.js'
import { FRONTEND_ORIGIN, TRUST_PROXY, PAYMENT_PROVIDER, assertPaymentProviderIsSafe } from './lib/config.js'
import { securityHeaders } from './middleware/security-headers.js'

assertPaymentProviderIsSafe()

const app = express()

// Opt-in — see the TRUST_PROXY comment in lib/config.ts. Only enable this
// when a trusted reverse proxy actually sits in front of this process.
if (TRUST_PROXY) {
  app.set('trust proxy', true)
} else if (process.env.NODE_ENV === 'production') {
  // A warning, not a throw: a deploy straight onto a VPS with no proxy is a
  // correct configuration, and refusing to boot would block it. But the
  // opposite mistake is silent and expensive — behind a proxy with this off,
  // every request arrives as the proxy's IP, so five wrong passwords from one
  // attacker lock every user out of login for the window.
  console.warn(
    'TRUST_PROXY is off in production. If this process sits behind a reverse proxy (most PaaS do), every request arrives as the proxy IP and the login rate limiter will lock all users out together. If nothing proxies this process, leaving it off is correct — see docs/DEPLOYMENT.md.',
  )
}

// Mounted before cors() and every route, so even a CORS rejection or an
// unmatched-route 404 carries these headers.
app.use(securityHeaders)

app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }))
// Must be mounted before express.json(): the JSON parser reads the request
// stream to completion and discards the original bytes, and the webhook
// signature has to be verified against the exact bytes the provider signed.
app.use('/webhooks', express.raw({ type: 'application/json' }))
app.use(express.json())
app.use(cookieParser())

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.use('/auth', authRouter)
app.use('/events', eventsRouter)
app.use('/showtimes', showtimesRouter)
app.use('/bookings', bookingsRouter)
app.use('/webhooks', webhooksRouter)
app.use('/tickets', ticketsRouter)
app.use('/me', meTicketsRouter)
app.use('/admin', adminRouter)

// Mounted only for the mock provider. Not mounted-then-guarded: a route that
// does not exist cannot be reached by a misconfiguration.
if (PAYMENT_PROVIDER === 'mock') {
  const { default: mockProviderRouter } = await import('./routes/mock-provider.js')
  app.use('/mock-provider', mockProviderRouter)
}

const PORT = process.env.PORT ?? 4000
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`)
})
