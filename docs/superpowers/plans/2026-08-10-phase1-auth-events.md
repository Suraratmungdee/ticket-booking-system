# Phase 1 — Auth + ค้นหา/ดู Event Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the npm-workspaces monorepo (`apps/web`, `apps/api`), add the `User`/`Venue`/`Event`/`Showtime` Prisma models, ship register/login with hashed passwords + httpOnly JWT cookie, CORS-locked to the frontend origin, and public event list/detail pages backed by real API endpoints.

**Architecture:** Express REST API in `apps/api` owns Postgres (via Prisma) and all business logic; Next.js 16 App Router app in `apps/web` only renders UI and calls the API through one fetch wrapper. No frontend business logic, no direct DB access from `apps/web`.

**Tech Stack:** Next.js 16 (App Router, TS), Express + TS, Prisma + PostgreSQL, bcrypt, jsonwebtoken, zod, cors, cookie-parser, Tailwind CSS, Vitest.

## Global Constraints

- Frontend and backend are separate apps under `apps/web` and `apps/api`, joined by npm workspaces (`workspaces: ["apps/*"]`) — from `CLAUDE.md` §2–3.
- Frontend has zero business logic; it only calls the API and renders — `CLAUDE.md` §3, §4.2.
- Money/seat/booking logic must live in `apps/api/src/lib` as single shared functions — not applicable to this phase (no seats/bookings yet), but auth logic still goes in `apps/api/src/lib/auth.ts`, not inline in routes.
- No hardcoded business constants scattered across files — bcrypt rounds, JWT expiry, cookie name, CORS origin all live in `apps/api/src/lib/config.ts` — `CLAUDE.md` §4.3.
- Passwords must be hashed (bcrypt), never stored plaintext — `CLAUDE.md` §5, plan §7.
- Login sets JWT as an **httpOnly** cookie — plan §7 item 3.
- CORS on `apps/api` must accept only the `apps/web` origin — plan §7 item 4.
- Only these 4 Prisma models this phase: `User`, `Venue`, `Event`, `Showtime`. No `Seat`/`Booking`/`Payment` — plan §7 item 2.
- Unit tests required for auth logic: login success + login with wrong password, at minimum — plan §7 mandatory requirements.
- Test files live under top-level `/tests/unit`, covering both apps — `CLAUDE.md` §3.
- No secrets committed; `.env` is gitignored, only `.env.example` with placeholder values is committed — `CLAUDE.md` §4.5.
- No new dependency categories (queues, extra services, GraphQL, Turborepo/Nx) — `CLAUDE.md` §2. (zod is a small validation lib already recommended by this repo's own `.claude/commands/new-endpoint.md`, not a new architectural dependency.)
- `npm run build` and `npm test` must pass in both apps before the work is called done — `CLAUDE.md` §6.

---

### Task 0: Root workspace scaffold

**Files:**
- Create: `package.json` (root)
- Create: `.gitignore`
- Create: `docker-compose.yml`

**Interfaces:**
- Produces: root npm scripts `build` and `test` that fan out to both workspaces with `--if-present`, so a workspace without a `test` script doesn't fail the run.

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "ticket-booking-system",
  "private": true,
  "workspaces": ["apps/*"],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "dev:api": "npm run dev --workspace apps/api",
    "dev:web": "npm run dev --workspace apps/web"
  }
}
```

- [ ] **Step 2: Create root `.gitignore`**

```
node_modules/
.env
.env.local
apps/api/dist/
apps/api/node_modules/
apps/web/.next/
apps/web/node_modules/
.DS_Store
```

- [ ] **Step 3: Create `docker-compose.yml` for local Postgres**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ticket
      POSTGRES_PASSWORD: ticket
      POSTGRES_DB: ticket_booking
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

- [ ] **Step 4: Verify**

Run: `cat package.json && docker compose config >/dev/null && echo OK`
Expected: prints the JSON and `OK` (compose file is syntactically valid).

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore docker-compose.yml
git commit -m "chore: scaffold npm workspaces root"
```

---

### Task 1: `apps/api` scaffold (Express + TS, boots empty)

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/.env.example`
- Create: `apps/api/src/index.ts`

**Interfaces:**
- Produces: an Express app listening on `process.env.PORT ?? 4000`, with a `GET /health` route returning `{ ok: true }` (used to sanity-check the server boots before wiring real routes).

- [ ] **Step 1: Create `apps/api/package.json`**

```json
{
  "name": "@ticket-booking/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "prisma generate && tsc",
    "start": "node dist/index.js",
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
cd apps/api && npm install express cors cookie-parser bcrypt jsonwebtoken zod @prisma/client
npm install -D typescript tsx vitest @types/node @types/express @types/cors @types/cookie-parser @types/bcrypt @types/jsonwebtoken prisma
```

- [ ] **Step 3: Create `apps/api/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `apps/api/.env.example`**

```
DATABASE_URL="postgresql://ticket:ticket@localhost:5432/ticket_booking"
JWT_SECRET="change-me-in-production"
FRONTEND_ORIGIN="http://localhost:3000"
PORT=4000
```

- [ ] **Step 5: Create `apps/api/src/index.ts`**

```ts
import express from 'express'

const app = express()

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

const PORT = process.env.PORT ?? 4000
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`)
})
```

- [ ] **Step 6: Verify it boots**

Run: `cd apps/api && npx tsx src/index.ts & sleep 1 && curl -s http://localhost:4000/health && kill %1`
Expected: `{"ok":true}`

- [ ] **Step 7: Commit**

```bash
git add apps/api/package.json apps/api/tsconfig.json apps/api/.env.example apps/api/src/index.ts
git commit -m "feat(api): scaffold Express app with health check"
```

---

### Task 2: Prisma schema (User, Venue, Event, Showtime) + client generation

**Files:**
- Create: `apps/api/prisma/schema.prisma`

**Interfaces:**
- Produces: `@prisma/client` types for `User { id, email, passwordHash, name, role, createdAt }`, `Venue { id, name, address }`, `Event { id, title, description, venueId }`, `Showtime { id, eventId, startTime, endTime, status }` — consumed by Tasks 3–6.

- [ ] **Step 1: Write `apps/api/prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  USER
  ADMIN
}

enum ShowtimeStatus {
  SCHEDULED
  CANCELLED
}

model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String
  name         String
  role         Role     @default(USER)
  createdAt    DateTime @default(now())
}

model Venue {
  id      String  @id @default(cuid())
  name    String
  address String
  events  Event[]
}

model Event {
  id          String     @id @default(cuid())
  title       String
  description String
  venueId     String
  venue       Venue      @relation(fields: [venueId], references: [id])
  showtimes   Showtime[]
}

model Showtime {
  id        String         @id @default(cuid())
  eventId   String
  event     Event          @relation(fields: [eventId], references: [id])
  startTime DateTime
  endTime   DateTime
  status    ShowtimeStatus @default(SCHEDULED)
}
```

- [ ] **Step 2: Copy env and generate the client (no DB connection needed for this step)**

Run: `cd apps/api && cp .env.example .env && npx prisma generate`
Expected: `Generated Prisma Client` success message.

- [ ] **Step 3: Bring up local Postgres and create the migration**

Run:
```bash
docker compose up -d postgres
# wait for it to accept connections, then:
cd apps/api && npx prisma migrate dev --name init
```
Expected: `The following migration(s) have been created and applied: .../init/` and a new `apps/api/prisma/migrations/*_init/migration.sql` file.

If Docker is not available in this environment, **stop and tell the user**: schema + client are ready, but the migration needs to be created/applied against a real dev Postgres (`docker compose up -d postgres && npx prisma migrate dev --name init` from `apps/api`) before `/auth/register` etc. will actually work end-to-end. Do not skip this silently.

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma
git commit -m "feat(api): add User/Venue/Event/Showtime Prisma schema"
```

---

### Task 3: Shared config + Prisma client singleton

**Files:**
- Create: `apps/api/src/lib/config.ts`
- Create: `apps/api/src/lib/prisma.ts`

**Interfaces:**
- Produces: `config.ts` exports `BCRYPT_SALT_ROUNDS: number`, `JWT_SECRET: string`, `JWT_EXPIRES_IN: string`, `JWT_COOKIE_NAME: string`, `FRONTEND_ORIGIN: string`.
- Produces: `prisma.ts` exports `prisma: PrismaClient` (singleton) — consumed by Tasks 4 and 6.

- [ ] **Step 1: Create `apps/api/src/lib/config.ts`**

```ts
export const BCRYPT_SALT_ROUNDS = 10
export const JWT_EXPIRES_IN = '2h'
export const JWT_COOKIE_NAME = 'token'

// LIMITATION: falls back to a dev-only secret so local boot never crashes;
// production must set a real JWT_SECRET or every token becomes forgeable.
export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me'

export const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000'
```

- [ ] **Step 2: Create `apps/api/src/lib/prisma.ts`**

```ts
import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()
```

- [ ] **Step 3: Verify it compiles**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/config.ts apps/api/src/lib/prisma.ts
git commit -m "feat(api): add shared config and Prisma client singleton"
```

---

### Task 4: Auth business logic + unit tests (TDD)

**Files:**
- Create: `apps/api/src/lib/auth.ts`
- Test: `tests/unit/api/auth.test.ts`
- Create: `apps/api/vitest.config.ts`

**Interfaces:**
- Consumes: `prisma` from `apps/api/src/lib/prisma.ts`; `BCRYPT_SALT_ROUNDS`, `JWT_SECRET`, `JWT_EXPIRES_IN` from `apps/api/src/lib/config.ts`.
- Produces: `registerUser(input: { email: string; password: string; name: string }): Promise<PublicUser>`, `loginUser(input: { email: string; password: string }): Promise<{ token: string; user: PublicUser }>`, and error classes `InvalidCredentialsError`, `EmailAlreadyRegisteredError` — consumed by Task 5's routes.

- [ ] **Step 1: Create `apps/api/vitest.config.ts` so tests can live in the shared `/tests/unit` folder**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['../../tests/unit/api/**/*.test.ts'],
  },
})
```

- [ ] **Step 2: Write the failing test — `tests/unit/api/auth.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import bcrypt from 'bcrypt'

vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}))

import { prisma } from '../../../apps/api/src/lib/prisma'
import { loginUser, registerUser, InvalidCredentialsError, EmailAlreadyRegisteredError } from '../../../apps/api/src/lib/auth'

const mockedFindUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
const mockedCreate = prisma.user.create as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockedFindUnique.mockReset()
  mockedCreate.mockReset()
})

describe('loginUser', () => {
  it('returns a token and public user on correct password', async () => {
    const passwordHash = await bcrypt.hash('correct-horse', 10)
    mockedFindUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      passwordHash,
      name: 'Ann',
      role: 'USER',
    })

    const result = await loginUser({ email: 'a@b.com', password: 'correct-horse' })

    expect(result.token).toEqual(expect.any(String))
    expect(result.user).toEqual({ id: 'u1', email: 'a@b.com', name: 'Ann', role: 'USER' })
  })

  it('throws InvalidCredentialsError on wrong password', async () => {
    const passwordHash = await bcrypt.hash('correct-horse', 10)
    mockedFindUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      passwordHash,
      name: 'Ann',
      role: 'USER',
    })

    await expect(loginUser({ email: 'a@b.com', password: 'wrong' })).rejects.toThrow(
      InvalidCredentialsError,
    )
  })

  it('throws InvalidCredentialsError when the email does not exist', async () => {
    mockedFindUnique.mockResolvedValue(null)

    await expect(
      loginUser({ email: 'nobody@b.com', password: 'anything' }),
    ).rejects.toThrow(InvalidCredentialsError)
  })
})

describe('registerUser', () => {
  it('throws EmailAlreadyRegisteredError when the email is taken', async () => {
    mockedFindUnique.mockResolvedValue({ id: 'u1' })

    await expect(
      registerUser({ email: 'a@b.com', password: 'pw12345678', name: 'Ann' }),
    ).rejects.toThrow(EmailAlreadyRegisteredError)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && npx vitest run`
Expected: FAIL — `Cannot find module '../../../apps/api/src/lib/auth'`.

- [ ] **Step 4: Write `apps/api/src/lib/auth.ts`**

```ts
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { prisma } from './prisma'
import { BCRYPT_SALT_ROUNDS, JWT_SECRET, JWT_EXPIRES_IN } from './config'

export class InvalidCredentialsError extends Error {}
export class EmailAlreadyRegisteredError extends Error {}

export type PublicUser = {
  id: string
  email: string
  name: string
  role: string
}

function toPublicUser(user: { id: string; email: string; name: string; role: string }): PublicUser {
  return { id: user.id, email: user.email, name: user.name, role: user.role }
}

export async function registerUser(input: {
  email: string
  password: string
  name: string
}): Promise<PublicUser> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } })
  if (existing) throw new EmailAlreadyRegisteredError()

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_SALT_ROUNDS)
  const user = await prisma.user.create({
    data: { email: input.email, passwordHash, name: input.name },
  })
  return toPublicUser(user)
}

export async function loginUser(input: {
  email: string
  password: string
}): Promise<{ token: string; user: PublicUser }> {
  const user = await prisma.user.findUnique({ where: { email: input.email } })
  if (!user) throw new InvalidCredentialsError()

  const valid = await bcrypt.compare(input.password, user.passwordHash)
  if (!valid) throw new InvalidCredentialsError()

  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  })
  return { token, user: toPublicUser(user) }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && npx vitest run`
Expected: PASS — 4 tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/auth.ts apps/api/vitest.config.ts tests/unit/api/auth.test.ts
git commit -m "feat(api): add auth business logic with unit tests"
```

---

### Task 5: Auth routes + CORS wiring

**Files:**
- Create: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Consumes: `registerUser`, `loginUser`, `InvalidCredentialsError`, `EmailAlreadyRegisteredError` from `apps/api/src/lib/auth.ts`; `JWT_COOKIE_NAME`, `FRONTEND_ORIGIN` from `apps/api/src/lib/config.ts`.
- Produces: `POST /auth/register`, `POST /auth/login` mounted at `/auth`; `express.Router` default export from `routes/auth.ts` — consumed by `index.ts`.

- [ ] **Step 1: Create `apps/api/src/routes/auth.ts`**

```ts
import { Router } from 'express'
import { z } from 'zod'
import {
  registerUser,
  loginUser,
  InvalidCredentialsError,
  EmailAlreadyRegisteredError,
} from '../lib/auth'
import { JWT_COOKIE_NAME } from '../lib/config'

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
    if (err instanceof EmailAlreadyRegisteredError) {
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
```

- [ ] **Step 2: Wire into `apps/api/src/index.ts`**

```ts
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import authRouter from './routes/auth'
import { FRONTEND_ORIGIN } from './lib/config'

const app = express()

app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }))
app.use(express.json())
app.use(cookieParser())

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

app.use('/auth', authRouter)

const PORT = process.env.PORT ?? 4000
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`)
})
```

- [ ] **Step 3: Manual verify (requires the migration from Task 2 Step 3 to be applied)**

Run:
```bash
cd apps/api && npx tsx src/index.ts &
sleep 1
curl -s -X POST http://localhost:4000/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com","password":"pw12345678","name":"Ann"}'
curl -si -X POST http://localhost:4000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com","password":"wrong"}'
kill %1
```
Expected: register returns `201` with the user; login with wrong password returns `401`; a correct-password login (test separately) returns `Set-Cookie: token=...; HttpOnly`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/index.ts
git commit -m "feat(api): add /auth/register and /auth/login with CORS"
```

---

### Task 6: Events routes

**Files:**
- Create: `apps/api/src/routes/events.ts`
- Modify: `apps/api/src/index.ts`
- Test: `tests/unit/api/events.test.ts`

**Interfaces:**
- Consumes: `prisma` from `apps/api/src/lib/prisma.ts`.
- Produces: `GET /events?date=YYYY-MM-DD&venueId=...`, `GET /events/:id` mounted at `/events`.
- Decision: filters by exact `venueId`, not fuzzy venue-name search — simplest option that's still correct; upgrade to name search if product asks for it later.
- Decision: `date` filters events having at least one showtime whose `startTime` falls within that UTC calendar day.

- [ ] **Step 1: Write the failing test — `tests/unit/api/events.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: {
    event: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}))

import { prisma } from '../../../apps/api/src/lib/prisma'
import { listEvents, getEventById } from '../../../apps/api/src/lib/events'

const mockedFindMany = prisma.event.findMany as unknown as ReturnType<typeof vi.fn>
const mockedFindUnique = prisma.event.findUnique as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockedFindMany.mockReset()
  mockedFindUnique.mockReset()
})

describe('listEvents', () => {
  it('filters by venueId when provided', async () => {
    mockedFindMany.mockResolvedValue([])
    await listEvents({ venueId: 'v1' })
    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId: 'v1' }),
      }),
    )
  })
})

describe('getEventById', () => {
  it('returns null when the event does not exist', async () => {
    mockedFindUnique.mockResolvedValue(null)
    const result = await getEventById('missing')
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run`
Expected: FAIL — `Cannot find module '../../../apps/api/src/lib/events'`.

- [ ] **Step 3: Write `apps/api/src/lib/events.ts`**

```ts
import { prisma } from './prisma'

export async function listEvents(filters: { date?: string; venueId?: string }) {
  return prisma.event.findMany({
    where: {
      ...(filters.venueId ? { venueId: filters.venueId } : {}),
      ...(filters.date
        ? {
            showtimes: {
              some: {
                startTime: {
                  gte: new Date(`${filters.date}T00:00:00.000Z`),
                  lt: new Date(`${filters.date}T23:59:59.999Z`),
                },
              },
            },
          }
        : {}),
    },
    include: { venue: true, showtimes: true },
  })
}

export async function getEventById(id: string) {
  return prisma.event.findUnique({
    where: { id },
    include: { venue: true, showtimes: true },
  })
}
```

- [ ] **Step 4: Write `apps/api/src/routes/events.ts`**

```ts
import { Router } from 'express'
import { listEvents, getEventById } from '../lib/events'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const { date, venueId } = req.query
    const events = await listEvents({
      date: typeof date === 'string' ? date : undefined,
      venueId: typeof venueId === 'string' ? venueId : undefined,
    })
    return res.json({ events })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const event = await getEventById(req.params.id)
    if (!event) return res.status(404).json({ error: 'Event not found' })
    return res.json({ event })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
```

- [ ] **Step 5: Wire into `apps/api/src/index.ts`** — add near the auth import:

```ts
import eventsRouter from './routes/events'
// ...
app.use('/events', eventsRouter)
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/api && npx vitest run`
Expected: PASS — all tests green (auth + events).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/events.ts apps/api/src/routes/events.ts apps/api/src/index.ts tests/unit/api/events.test.ts
git commit -m "feat(api): add GET /events and GET /events/:id"
```

---

### Task 7: `apps/web` scaffold (Next.js 16 App Router + Tailwind)

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/postcss.config.mjs`
- Create: `apps/web/app/globals.css`
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/page.tsx`
- Create: `apps/web/.env.example`

**Interfaces:**
- Produces: a running Next.js app at `localhost:3000` with a home page linking to `/login`, `/register`, `/events`.

- [ ] **Step 1: Create `apps/web/package.json`**

```json
{
  "name": "@ticket-booking/web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
cd apps/web && npm install next@^16 react@^19 react-dom@^19
npm install -D typescript @types/node @types/react @types/react-dom tailwindcss @tailwindcss/postcss
```

- [ ] **Step 3: Create `apps/web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "incremental": true,
    "paths": { "@/*": ["./*"] },
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create `apps/web/next.config.ts`**

```ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {}

export default nextConfig
```

- [ ] **Step 5: Create `apps/web/postcss.config.mjs`**

```js
export default {
  plugins: { '@tailwindcss/postcss': {} },
}
```

- [ ] **Step 6: Create `apps/web/app/globals.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 7: Create `apps/web/app/layout.tsx`**

```tsx
import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Ticket Booking',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body className="min-h-screen bg-white text-gray-900">{children}</body>
    </html>
  )
}
```

- [ ] **Step 8: Create `apps/web/app/page.tsx`**

```tsx
import Link from 'next/link'

export default function HomePage() {
  return (
    <main className="mx-auto max-w-xl p-8 flex flex-col gap-4">
      <h1 className="text-2xl font-bold">ระบบจองตั๋ว</h1>
      <nav className="flex gap-4">
        <Link className="underline" href="/events">
          ดูรายการ Event
        </Link>
        <Link className="underline" href="/login">
          เข้าสู่ระบบ
        </Link>
        <Link className="underline" href="/register">
          สมัครสมาชิก
        </Link>
      </nav>
    </main>
  )
}
```

- [ ] **Step 9: Create `apps/web/.env.example`**

```
NEXT_PUBLIC_API_URL="http://localhost:4000"
```

- [ ] **Step 10: Verify it builds and boots**

Run: `cd apps/web && cp .env.example .env.local && npx next build`
Expected: build succeeds with no type errors.

- [ ] **Step 11: Commit**

```bash
git add apps/web/package.json apps/web/tsconfig.json apps/web/next.config.ts apps/web/postcss.config.mjs apps/web/app apps/web/.env.example
git commit -m "feat(web): scaffold Next.js 16 app with Tailwind"
```

---

### Task 8: API fetch wrapper

**Files:**
- Create: `apps/web/lib/api.ts`

**Interfaces:**
- Produces: `apiFetch(path: string, options?: RequestInit): Promise<Response>` — consumed by Tasks 9–11. Always sends `credentials: 'include'` so the httpOnly auth cookie round-trips.

- [ ] **Step 1: Create `apps/web/lib/api.ts`**

```ts
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    credentials: 'include',
  })
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/api.ts
git commit -m "feat(web): add API fetch wrapper"
```

---

### Task 9: Login and register pages

**Files:**
- Create: `apps/web/app/login/page.tsx`
- Create: `apps/web/app/register/page.tsx`

**Interfaces:**
- Consumes: `apiFetch` from `apps/web/lib/api.ts`; calls `POST /auth/login` and `POST /auth/register`.

- [ ] **Step 1: Create `apps/web/app/register/page.tsx`**

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api'

export default function RegisterPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = new FormData(e.currentTarget)

    const res = await apiFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: form.get('email'),
        password: form.get('password'),
        name: form.get('name'),
      }),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error ?? 'สมัครสมาชิกไม่สำเร็จ')
      return
    }

    router.push('/login')
  }

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-xl font-bold mb-4">สมัครสมาชิก</h1>
      {error && <p className="text-red-600 mb-2">{error}</p>}
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input name="name" placeholder="ชื่อ" required className="border p-2 rounded" />
        <input
          name="email"
          type="email"
          placeholder="อีเมล"
          required
          className="border p-2 rounded"
        />
        <input
          name="password"
          type="password"
          placeholder="รหัสผ่าน (8 ตัวขึ้นไป)"
          required
          minLength={8}
          className="border p-2 rounded"
        />
        <button type="submit" className="bg-black text-white p-2 rounded">
          สมัครสมาชิก
        </button>
      </form>
    </main>
  )
}
```

- [ ] **Step 2: Create `apps/web/app/login/page.tsx`**

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api'

export default function LoginPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = new FormData(e.currentTarget)

    const res = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: form.get('email'),
        password: form.get('password'),
      }),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error ?? 'เข้าสู่ระบบไม่สำเร็จ')
      return
    }

    router.push('/events')
  }

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-xl font-bold mb-4">เข้าสู่ระบบ</h1>
      {error && <p className="text-red-600 mb-2">{error}</p>}
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input
          name="email"
          type="email"
          placeholder="อีเมล"
          required
          className="border p-2 rounded"
        />
        <input
          name="password"
          type="password"
          placeholder="รหัสผ่าน"
          required
          className="border p-2 rounded"
        />
        <button type="submit" className="bg-black text-white p-2 rounded">
          เข้าสู่ระบบ
        </button>
      </form>
    </main>
  )
}
```

- [ ] **Step 3: Verify build**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/login apps/web/app/register
git commit -m "feat(web): add login and register pages"
```

---

### Task 10: `/events` list page with date/venue filter

**Files:**
- Create: `apps/web/app/events/page.tsx`

**Interfaces:**
- Consumes: `GET /events?date=&venueId=` via server-side `fetch` (not `apiFetch`, since this runs on the server and reads `NEXT_PUBLIC_API_URL` directly — no cookies needed for a public listing).
- Uses a native `<form method="get">` for filters so no client JS/state is needed — the browser re-navigates to `/events?date=...&venueId=...`.

- [ ] **Step 1: Create `apps/web/app/events/page.tsx`**

```tsx
import Link from 'next/link'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

type EventListItem = {
  id: string
  title: string
  description: string
  venue: { id: string; name: string }
  showtimes: { id: string; startTime: string }[]
}

async function fetchEvents(searchParams: { date?: string; venueId?: string }) {
  const params = new URLSearchParams()
  if (searchParams.date) params.set('date', searchParams.date)
  if (searchParams.venueId) params.set('venueId', searchParams.venueId)

  const res = await fetch(`${API_URL}/events?${params.toString()}`, { cache: 'no-store' })
  if (!res.ok) return []
  const data = await res.json()
  return data.events as EventListItem[]
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; venueId?: string }>
}) {
  const params = await searchParams
  const events = await fetchEvents(params)

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-xl font-bold mb-4">รายการ Event</h1>

      <form method="get" className="flex gap-2 mb-6">
        <input
          type="date"
          name="date"
          defaultValue={params.date ?? ''}
          className="border p-2 rounded"
        />
        <input
          type="text"
          name="venueId"
          placeholder="Venue ID"
          defaultValue={params.venueId ?? ''}
          className="border p-2 rounded"
        />
        <button type="submit" className="bg-black text-white px-3 rounded">
          กรอง
        </button>
      </form>

      <ul className="flex flex-col gap-3">
        {events.map((event) => (
          <li key={event.id} className="border rounded p-3">
            <Link href={`/events/${event.id}`} className="font-semibold underline">
              {event.title}
            </Link>
            <p className="text-sm text-gray-600">{event.venue.name}</p>
          </li>
        ))}
        {events.length === 0 && <p className="text-gray-500">ไม่พบ event</p>}
      </ul>
    </main>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/events/page.tsx
git commit -m "feat(web): add /events list page with date/venue filter"
```

---

### Task 11: `/events/[id]` detail page

**Files:**
- Create: `apps/web/app/events/[id]/page.tsx`

**Interfaces:**
- Consumes: `GET /events/:id`.

- [ ] **Step 1: Create `apps/web/app/events/[id]/page.tsx`**

```tsx
import { notFound } from 'next/navigation'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

type EventDetail = {
  id: string
  title: string
  description: string
  venue: { id: string; name: string; address: string }
  showtimes: { id: string; startTime: string; endTime: string; status: string }[]
}

async function fetchEvent(id: string): Promise<EventDetail | null> {
  const res = await fetch(`${API_URL}/events/${id}`, { cache: 'no-store' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error('Failed to load event')
  const data = await res.json()
  return data.event as EventDetail
}

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const event = await fetchEvent(id)
  if (!event) notFound()

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-bold">{event.title}</h1>
      <p className="text-gray-600">{event.venue.name} — {event.venue.address}</p>
      <p className="mt-4">{event.description}</p>

      <h2 className="text-lg font-semibold mt-6 mb-2">รอบที่มี</h2>
      <ul className="flex flex-col gap-2">
        {event.showtimes.map((showtime) => (
          <li key={showtime.id} className="border rounded p-3">
            {new Date(showtime.startTime).toLocaleString('th-TH')} —{' '}
            {new Date(showtime.endTime).toLocaleString('th-TH')} ({showtime.status})
          </li>
        ))}
        {event.showtimes.length === 0 && <p className="text-gray-500">ยังไม่มีรอบ</p>}
      </ul>
    </main>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/app/events/[id]/page.tsx"
git commit -m "feat(web): add /events/[id] detail page"
```

---

### Task 12: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Root build**

Run: `npm run build`
Expected: both `apps/api` and `apps/web` build with no type errors.

- [ ] **Step 2: Root test**

Run: `npm test`
Expected: `apps/api` vitest suite passes (auth + events); `apps/web` has no test script so it's skipped via `--if-present`.

- [ ] **Step 3: Manual click-through (requires Postgres up + migration applied, both dev servers running)**

```bash
docker compose up -d postgres
npm run dev:api &
npm run dev:web &
```

Then in a browser: register a user at `/register` → redirected to `/login` → log in → redirected to `/events`. Confirm a `token` httpOnly cookie is set (DevTools → Application → Cookies). Manually insert a `Venue`/`Event`/`Showtime` row (via `npx prisma studio` in `apps/api`) and confirm it shows on `/events` and its detail page.

- [ ] **Step 4: Stop dev servers**

```bash
kill %1 %2
```

---

## End-of-phase summary template (fill in after execution)

- Files created/modified: (list)
- Build/test results: (paste output)
- Decisions made along the way: venue filter is exact `venueId` match (not name search); date filter matches UTC calendar day; JWT expiry 2h; no `apps/api/src/middleware` yet (nothing needs auth-guarding this phase — first consumer will be Phase 2/5); no `apps/web` unit tests yet (no frontend logic to test this phase).
- Needs human review: whether the Postgres migration was actually applied (requires Docker or a real dev DB, which may not exist in a sandboxed environment) — confirm before Phase 2 depends on running data.
