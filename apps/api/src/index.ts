import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import authRouter from './routes/auth.js'
import eventsRouter from './routes/events.js'
import showtimesRouter from './routes/showtimes.js'
import bookingsRouter from './routes/bookings.js'
import { FRONTEND_ORIGIN, TRUST_PROXY } from './lib/config.js'

const app = express()

// Opt-in — see the TRUST_PROXY comment in lib/config.ts. Only enable this
// when a trusted reverse proxy actually sits in front of this process.
if (TRUST_PROXY) {
  app.set('trust proxy', true)
}

app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }))
app.use(express.json())
app.use(cookieParser())

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.use('/auth', authRouter)
app.use('/events', eventsRouter)
app.use('/showtimes', showtimesRouter)
app.use('/bookings', bookingsRouter)

const PORT = process.env.PORT ?? 4000
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`)
})
