import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordAudit } from '../../../apps/api/src/lib/audit'

beforeEach(() => vi.clearAllMocks())

describe('recordAudit', () => {
  it('writes the entry through the transaction client it was given', async () => {
    const create = vi.fn().mockResolvedValue({})
    const tx = { adminAuditLog: { create } } as never

    await recordAudit(tx, {
      adminId: 'admin-1',
      action: 'event.create',
      targetType: 'Event',
      targetId: 'e1',
    })

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0].data).toEqual({
      adminId: 'admin-1',
      action: 'event.create',
      targetType: 'Event',
      targetId: 'e1',
    })
  })

  // If it swallowed errors, a failed log would leave the mutation committed
  // with no record of who made it — the exact thing an audit log exists to
  // prevent. Letting it throw rolls the whole transaction back.
  it('propagates a write failure instead of swallowing it', async () => {
    const create = vi.fn().mockRejectedValue(new Error('db down'))
    const tx = { adminAuditLog: { create } } as never

    await expect(
      recordAudit(tx, { adminId: 'a', action: 'event.create', targetType: 'Event', targetId: 'e' }),
    ).rejects.toThrow('db down')
  })
})
