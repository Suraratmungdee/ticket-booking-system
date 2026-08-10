import { prisma } from './prisma.js'

export async function listEvents(filters: { date?: string; venueId?: string }) {
  return prisma.event.findMany({
    where: {
      ...(filters.venueId ? { venueId: filters.venueId } : {}),
      ...(filters.date ? { showtimes: { some: { startTime: dayRange(filters.date) } } } : {}),
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

// gte start-of-day / lt start-of-next-day, both in UTC. Deliberately not
// `lt: T23:59:59.999Z` — that leaves a 1ms gap at the end of the day.
// setUTCDate rolls over month/year boundaries correctly without a date lib.
function dayRange(date: string) {
  const start = new Date(`${date}T00:00:00.000Z`)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 1)
  return { gte: start, lt: end }
}
