// Answers one question: when N people grab the same seat at the same instant,
// does exactly one of them get it?
//
// Run by hand against a running API — not part of any suite, because it needs
// a live server:
//   npm run dev:api          # in one terminal
//   npm run load:booking     # in another
//
// LIMITATION: measures correctness, not throughput. It reports no latency
// percentiles and no requests/second. Answering "how many bookings per second
// can this take" needs a real load tool, which means a new dependency — ask
// before adding one.
import { prisma } from '../../apps/api/src/lib/prisma'

const API = process.env.API_BASE_URL ?? 'http://localhost:4000'
const CONTENDERS = Number(process.env.CONTENDERS ?? 50)
const PASSWORD = 'load-test-password-1234'

async function main() {
  console.log(`Load: ${CONTENDERS} users contending for one seat against ${API}`)

  const stamp = Date.now()
  const venue = await prisma.venue.create({
    data: { name: `load ${stamp} venue`, address: 'n/a' },
  })
  const event = await prisma.event.create({
    data: { title: `load ${stamp} event`, description: 'n/a', venueId: venue.id },
  })
  const showtime = await prisma.showtime.create({
    data: {
      eventId: event.id,
      startTime: new Date(Date.now() + 60 * 60 * 1000),
      endTime: new Date(Date.now() + 2 * 60 * 60 * 1000),
    },
  })
  const seatMap = await prisma.seatMap.create({
    data: { showtimeId: showtime.id, zoneName: 'LOAD', price: 1000 },
  })
  const seat = await prisma.seat.create({
    data: { seatMapId: seatMap.id, row: 'A', number: 1 },
  })

  // Register through the real API so the passwords hash the same way login
  // expects, then keep each user's session cookie.
  const emails: string[] = []
  const cookies: string[] = []
  for (let i = 0; i < CONTENDERS; i++) {
    const email = `load-${stamp}-${i}@example.com`
    emails.push(email)
    const res = await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, name: `Load ${i}` }),
    })
    if (!res.ok) throw new Error(`register failed for ${email}: ${res.status}`)

    const login = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
    const cookie = login.headers.get('set-cookie')
    if (!login.ok || !cookie) throw new Error(`login failed for ${email}: ${login.status}`)
    cookies.push(cookie.split(';')[0])
  }

  // The burst. Fired together, not in a loop — a sequential loop proves
  // nothing about contention.
  const results = await Promise.allSettled(
    cookies.map((cookie) =>
      fetch(`${API}/showtimes/${showtime.id}/seats/hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ seatIds: [seat.id] }),
      }).then(async (r) => ({ status: r.status, body: await r.text() })),
    ),
  )

  const statuses = new Map<number | string, number>()
  for (const r of results) {
    const key = r.status === 'fulfilled' ? r.value.status : 'network-error'
    statuses.set(key, (statuses.get(key) ?? 0) + 1)
  }

  // The number that actually matters. HTTP responses can lie — two 201s with
  // one row, or one 201 with two rows, are both possible failure modes. Count
  // the rows.
  const rows = await prisma.bookingSeat.count({ where: { seatId: seat.id } })

  console.log('\nHTTP results:')
  for (const [status, count] of [...statuses].sort()) {
    console.log(`  ${status}: ${count}`)
  }
  console.log(`\nBookingSeat rows for the contended seat: ${rows}`)
  console.log(rows === 1 ? 'PASS — exactly one booking holds the seat' : `FAIL — expected 1, got ${rows}`)

  // Teardown, scoped to ids this run created. The dev Postgres is shared
  // with other worktrees; never widen these filters.
  //
  // LIMITATION: these are plain statements at the end of main(), not a
  // try/finally — this only runs on the success path. If anything above
  // throws first (a failed registration, a dropped connection mid-burst),
  // every delete below is skipped and this run's venue, event, showtime,
  // seat map, seat, users and any bookings are stranded in the shared dev
  // Postgres. Harmless to later runs (ids are timestamp-stamped, so nothing
  // collides), but the leftover `load <stamp> event` keeps showing up in
  // /events and /admin/events for every other worktree and accumulates
  // until someone deletes it by hand. See docs/DEPLOYMENT.md.
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  })
  const userIds = users.map((u) => u.id)
  await prisma.bookingSeat.deleteMany({ where: { seatId: seat.id } })
  await prisma.ticket.deleteMany({ where: { booking: { userId: { in: userIds } } } })
  await prisma.payment.deleteMany({ where: { booking: { userId: { in: userIds } } } })
  await prisma.booking.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.seat.deleteMany({ where: { id: seat.id } })
  await prisma.seatMap.deleteMany({ where: { id: seatMap.id } })
  await prisma.showtime.deleteMany({ where: { id: showtime.id } })
  await prisma.event.deleteMany({ where: { id: event.id } })
  await prisma.venue.deleteMany({ where: { id: venue.id } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })

  if (rows !== 1) process.exitCode = 1
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
