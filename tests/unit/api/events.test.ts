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
import { listEventsHandler, getEventByIdHandler } from '../../../apps/api/src/routes/events'

const mockedFindMany = prisma.event.findMany as unknown as ReturnType<typeof vi.fn>
const mockedFindUnique = prisma.event.findUnique as unknown as ReturnType<typeof vi.fn>

function fakeRes() {
  const res: any = {}
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  return res
}

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

  it('filters by the UTC calendar day, including 00:00:00.000 and excluding the next midnight', async () => {
    mockedFindMany.mockResolvedValue([])
    await listEvents({ date: '2026-08-10' })
    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          showtimes: {
            some: {
              startTime: {
                gte: new Date('2026-08-10T00:00:00.000Z'),
                lt: new Date('2026-08-11T00:00:00.000Z'),
              },
            },
          },
        }),
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

describe('listEventsHandler', () => {
  it('returns 400 for a malformed date instead of hitting the database', async () => {
    const req: any = { query: { date: 'banana' } }
    const res = fakeRes()

    await listEventsHandler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(mockedFindMany).not.toHaveBeenCalled()
  })

  it('returns 400 for a full ISO timestamp instead of hitting the database', async () => {
    // dayRange() interpolates the raw string into `${date}T00:00:00.000Z` —
    // a full timestamp like this produces an invalid date and must be
    // rejected by the guard before it ever reaches Prisma.
    const req: any = { query: { date: '2026-08-10T10:00:00Z' } }
    const res = fakeRes()

    await listEventsHandler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(mockedFindMany).not.toHaveBeenCalled()
  })
})

describe('getEventByIdHandler', () => {
  it('returns 404 when the event does not exist', async () => {
    mockedFindUnique.mockResolvedValue(null)
    const req: any = { params: { id: 'missing' } }
    const res = fakeRes()

    await getEventByIdHandler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'Event not found' })
  })
})
