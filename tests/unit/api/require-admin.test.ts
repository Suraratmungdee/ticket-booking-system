import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ userFindUnique: vi.fn() }))

vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: { user: { findUnique: m.userFindUnique } },
}))

import { requireAdmin } from '../../../apps/api/src/middleware/auth'

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() } as any
  res.status.mockReturnValue(res)
  res.json.mockReturnValue(res)
  return res
}

beforeEach(() => vi.clearAllMocks())

describe('requireAdmin', () => {
  it('passes an admin through', async () => {
    m.userFindUnique.mockResolvedValue({ role: 'ADMIN' })
    const next = vi.fn()
    const res = makeRes()

    await requireAdmin({ user: { id: 'u1', role: 'ADMIN' } } as never, res, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  // 404 not 403: a 403 confirms the admin routes exist.
  it('404s a normal user', async () => {
    m.userFindUnique.mockResolvedValue({ role: 'USER' })
    const next = vi.fn()
    const res = makeRes()

    await requireAdmin({ user: { id: 'u1', role: 'USER' } } as never, res, next)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(next).not.toHaveBeenCalled()
  })

  // THE test for this middleware. The JWT still says ADMIN because it was
  // issued before the demotion and lives for two hours; the database says
  // USER. Reading the role from the token instead of the database would let
  // a revoked admin keep full write access for the rest of that window.
  it('blocks a demoted admin immediately, even though their token still says ADMIN', async () => {
    m.userFindUnique.mockResolvedValue({ role: 'USER' })
    const next = vi.fn()
    const res = makeRes()

    await requireAdmin({ user: { id: 'u1', role: 'ADMIN' } } as never, res, next)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(next).not.toHaveBeenCalled()
  })

  it('404s when the user row no longer exists', async () => {
    m.userFindUnique.mockResolvedValue(null)
    const next = vi.fn()
    const res = makeRes()

    await requireAdmin({ user: { id: 'deleted', role: 'ADMIN' } } as never, res, next)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(next).not.toHaveBeenCalled()
  })

  it('401s when there is no session at all', async () => {
    const next = vi.fn()
    const res = makeRes()

    await requireAdmin({ user: undefined } as never, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(m.userFindUnique).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
})
