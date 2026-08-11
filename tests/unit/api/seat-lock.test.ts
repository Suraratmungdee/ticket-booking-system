import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSet = vi.fn()
const mockDel = vi.fn()
const mockMGet = vi.fn()

// getRedis itself is a vi.fn() (not a fixed factory return) so individual
// tests can make it reject, to simulate Redis being completely unreachable
// rather than just a command failing.
const { mockGetRedis } = vi.hoisted(() => ({ mockGetRedis: vi.fn() }))
vi.mock('../../../apps/api/src/lib/redis', () => ({ getRedis: mockGetRedis }))

import {
  acquireSeatHolds,
  releaseSeatHolds,
  getHeldSeatIds,
} from '../../../apps/api/src/lib/seat-lock'

beforeEach(() => {
  mockSet.mockReset()
  mockDel.mockReset()
  mockMGet.mockReset()
  mockGetRedis.mockReset()
  mockGetRedis.mockResolvedValue({ set: mockSet, del: mockDel, mGet: mockMGet })
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

// Finding 1: Redis is only a fast-fail gate, not the correctness guarantee
// (Postgres's SELECT ... FOR UPDATE is). When Redis itself is unreachable,
// every function here must fail *open* rather than propagate — otherwise a
// Redis outage would 500 both booking and seat-map browsing, which is
// exactly the failure mode the design document says must not happen.
describe('fail-open when Redis is unavailable', () => {
  beforeEach(() => {
    mockGetRedis.mockReset()
    mockGetRedis.mockRejectedValue(new Error('ECONNREFUSED'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('acquireSeatHolds still returns true (lets Postgres decide)', async () => {
    const ok = await acquireSeatHolds(['s1', 's2'], 'user-1')
    expect(ok).toBe(true)
  })

  it('getHeldSeatIds returns an empty set (no HELD overlay, not a crash)', async () => {
    const held = await getHeldSeatIds(['s1', 's2'])
    expect(held).toEqual(new Set())
  })

  it('releaseSeatHolds does not throw', async () => {
    await expect(releaseSeatHolds(['s1'])).resolves.toBeUndefined()
  })
})
