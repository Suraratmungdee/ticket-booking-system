import { prisma } from './prisma.js'
import { recordAudit } from './audit.js'

// Every mutation below follows the same shape: write, then record the audit
// entry, both inside one prisma.$transaction. Neither may land without the
// other.

export async function listVenues() {
  return prisma.venue.findMany({ orderBy: { name: 'asc' } })
}

export async function createVenue(adminId: string, input: { name: string; address: string }) {
  return prisma.$transaction(async (tx) => {
    const venue = await tx.venue.create({ data: input })
    await recordAudit(tx, {
      adminId,
      action: 'venue.create',
      targetType: 'Venue',
      targetId: venue.id,
    })
    return venue
  })
}

export async function updateVenue(
  adminId: string,
  id: string,
  input: { name?: string; address?: string },
) {
  return prisma.$transaction(async (tx) => {
    const venue = await tx.venue.update({ where: { id }, data: input })
    await recordAudit(tx, {
      adminId,
      action: 'venue.update',
      targetType: 'Venue',
      targetId: id,
    })
    return venue
  })
}

// Unlike GET /events, this is not filtered — an admin needs to see
// everything, including events with no showtimes yet.
//
// LIMITATION: no pagination. Fine at this catalog size; add a cursor once
// the list outgrows one screen.
export async function listAllEvents() {
  return prisma.event.findMany({
    orderBy: { title: 'asc' },
    include: { venue: true, showtimes: { orderBy: { startTime: 'asc' } } },
  })
}

export async function createEvent(
  adminId: string,
  input: { title: string; description: string; venueId: string },
) {
  return prisma.$transaction(async (tx) => {
    const event = await tx.event.create({ data: input })
    await recordAudit(tx, {
      adminId,
      action: 'event.create',
      targetType: 'Event',
      targetId: event.id,
    })
    return event
  })
}

export async function updateEvent(
  adminId: string,
  id: string,
  input: { title?: string; description?: string; venueId?: string },
) {
  return prisma.$transaction(async (tx) => {
    const event = await tx.event.update({ where: { id }, data: input })
    await recordAudit(tx, {
      adminId,
      action: 'event.update',
      targetType: 'Event',
      targetId: id,
    })
    return event
  })
}
