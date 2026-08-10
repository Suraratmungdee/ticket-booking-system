import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import authRouter from './routes/auth.js'
import eventsRouter from './routes/events.js'
import { FRONTEND_ORIGIN } from './lib/config.js'

const app = express()

app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }))
app.use(express.json())
app.use(cookieParser())

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.use('/auth', authRouter)
app.use('/events', eventsRouter)

const PORT = process.env.PORT ?? 4000
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`)
})
