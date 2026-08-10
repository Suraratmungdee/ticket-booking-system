import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSet = vi.fn()
const mockDel = vi.fn()
const mockMGet = vi.fn()

vi.mock('../../../apps/api/src/lib/redis', () => ({
  getRedis: async () => ({ set: mockSet, del: mockDel, mGet: mockMGet }),
}))

import {
  acquireSeatHolds,
  releaseSeatHolds,
  getHeldSeatIds,
} from '../../../apps/api/src/lib/seat-lock'

beforeEach(() => {
  mockSet.mockReset()
  mockDel.mockReset()
  mockMGet.mockReset()
})

describe('acquireSeatHolds', () => {
  it('returns true and locks every seat when all are free', async () => {
    mockSet.mockResolvedValue('OK')

    const ok = await acquireSeatHolds(['s1', 's2'], 'user-1')

    expect(ok).toBe(true)
    expect(mockSet).toHaveBeenCalledTimes(2)
    expect(mockDel).not.toHaveBeenCalled()
  })

  it('uses NX and a TTL so a crashed request cannot hold a seat forever', async () => {
    mockSet.mockResolvedValue('OK')

    await acquireSeatHolds(['s1'], 'user-1')

    expect(mockSet).toHaveBeenCalledWith(
      'hold:seat:s1',
      'user-1',
      expect.objectContaining({ NX: true, EX: 300 }),
    )
  })

  // The bug this whole function exists to prevent: partial acquisition that
  // strands the seats it did take for the full TTL.
  it('releases already-acquired seats when a later seat is taken', async () => {
    mockSet.mockResolvedValueOnce('OK').mockResolvedValueOnce('OK').mockResolvedValueOnce(null)

    const ok = await acquireSeatHolds(['s1', 's2', 's3'], 'user-1')

    expect(ok).toBe(false)
    expect(mockDel).toHaveBeenCalledWith(['hold:seat:s1', 'hold:seat:s2'])
  })

  it('does not release anything when the very first seat is taken', async () => {
    mockSet.mockResolvedValueOnce(null)

    const ok = await acquireSeatHolds(['s1', 's2'], 'user-1')

    expect(ok).toBe(false)
    expect(mockDel).not.toHaveBeenCalled()
    expect(mockSet).toHaveBeenCalledTimes(1)
  })
})

describe('getHeldSeatIds', () => {
  it('returns only the seats with a live hold, in one MGET', async () => {
    mockMGet.mockResolvedValue(['user-1', null, 'user-2'])

    const held = await getHeldSeatIds(['s1', 's2', 's3'])

    expect(mockMGet).toHaveBeenCalledOnce()
    expect(held).toEqual(new Set(['s1', 's3']))
  })

  it('returns an empty set for an empty input without calling Redis', async () => {
    const held = await getHeldSeatIds([])

    expect(held.size).toBe(0)
    expect(mockMGet).not.toHaveBeenCalled()
  })
})

describe('releaseSeatHolds', () => {
  it('does nothing for an empty list', async () => {
    await releaseSeatHolds([])
    expect(mockDel).not.toHaveBeenCalled()
  })
})
