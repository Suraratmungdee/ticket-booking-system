import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  venueFindMany: vi.fn(),
  eventFindMany: vi.fn(),
  venueCreate: vi.fn(),
  venueUpdate: vi.fn(),
  eventCreate: vi.fn(),
  eventUpdate: vi.fn(),
  auditCreate: vi.fn(),
}))

vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: {
    $transaction: m.transaction,
    venue: { findMany: m.venueFindMany },
    event: { findMany: m.eventFindMany },
  },
}))

import {
  createVenue,
  updateVenue,
  createEvent,
  updateEvent,
} from '../../../apps/api/src/lib/admin'

// Every mutation runs inside one transaction; this stub is the client it gets.
function txRuns() {
  m.transaction.mockImplementation(async (fn: (t: unknown) => unknown) =>
    fn({
      venue: { create: m.venueCreate, update: m.venueUpdate },
      event: { create: m.eventCreate, update: m.eventUpdate },
      adminAuditLog: { create: m.auditCreate },
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  txRuns()
  // vi.clearAllMocks() clears call history but not a prior test's
  // mockRejectedValue — without this, the "audit fails" test below would
  // leak its rejection into every test that runs after it.
  m.auditCreate.mockResolvedValue(undefined)
})

describe('createVenue', () => {
  it('creates the venue and its audit entry in one transaction', async () => {
    m.venueCreate.mockResolvedValue({ id: 'v1', name: 'หอประชุม', address: 'กรุงเทพฯ' })

    const venue = await createVenue('admin-1', { name: 'หอประชุม', address: 'กรุงเทพฯ' })

    expect(venue.id).toBe('v1')
    expect(m.transaction).toHaveBeenCalledTimes(1)
    expect(m.auditCreate).toHaveBeenCalledTimes(1)
    expect(m.auditCreate.mock.calls[0][0].data).toEqual({
      adminId: 'admin-1',
      action: 'venue.create',
      targetType: 'Venue',
      targetId: 'v1',
    })
  })

  // The audit write must be inside the transaction, so a failure takes the
  // whole thing down rather than leaving an unlogged change behind.
  it('rejects and writes nothing when the audit entry fails', async () => {
    m.venueCreate.mockResolvedValue({ id: 'v1' })
    m.auditCreate.mockRejectedValue(new Error('audit down'))

    await expect(createVenue('admin-1', { name: 'x', address: 'y' })).rejects.toThrow('audit down')
  })
})

describe('updateVenue', () => {
  it('records a venue.update entry against the venue id', async () => {
    m.venueUpdate.mockResolvedValue({ id: 'v1', name: 'ใหม่', address: 'กรุงเทพฯ' })

    await updateVenue('admin-1', 'v1', { name: 'ใหม่' })

    expect(m.venueUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'v1' }, data: { name: 'ใหม่' } }),
    )
    expect(m.auditCreate.mock.calls[0][0].data).toEqual({
      adminId: 'admin-1',
      action: 'venue.update',
      targetType: 'Venue',
      targetId: 'v1',
    })
  })
})

describe('createEvent', () => {
  it('creates the event and its audit entry in one transaction', async () => {
    m.eventCreate.mockResolvedValue({ id: 'e1', title: 'คอนเสิร์ต' })

    const event = await createEvent('admin-1', {
      title: 'คอนเสิร์ต',
      description: 'รายละเอียด',
      venueId: 'v1',
    })

    expect(event.id).toBe('e1')
    expect(m.auditCreate.mock.calls[0][0].data).toEqual({
      adminId: 'admin-1',
      action: 'event.create',
      targetType: 'Event',
      targetId: 'e1',
    })
  })
})

describe('updateEvent', () => {
  it('records an event.update entry', async () => {
    m.eventUpdate.mockResolvedValue({ id: 'e1', title: 'ใหม่' })

    await updateEvent('admin-1', 'e1', { title: 'ใหม่' })

    expect(m.auditCreate.mock.calls[0][0].data.action).toBe('event.update')
    expect(m.auditCreate.mock.calls[0][0].data.targetId).toBe('e1')
  })
})
