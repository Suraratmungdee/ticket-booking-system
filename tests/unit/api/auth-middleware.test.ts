import { describe, it, expect, vi, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { requireAuth } from '../../../apps/api/src/middleware/auth'
import { JWT_SECRET, JWT_COOKIE_NAME } from '../../../apps/api/src/lib/config'

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() } as any
  res.status.mockReturnValue(res)
  res.json.mockReturnValue(res)
  return res
}

beforeEach(() => vi.clearAllMocks())

describe('requireAuth', () => {
  it('sets req.user and calls next() for a valid token', () => {
    const token = jwt.sign({ sub: 'user-1', role: 'USER' }, JWT_SECRET, { expiresIn: 60 })
    const req = { cookies: { [JWT_COOKIE_NAME]: token } } as any
    const res = makeRes()
    const next = vi.fn()

    requireAuth(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.user).toEqual({ id: 'user-1', role: 'USER' })
    expect(res.status).not.toHaveBeenCalled()
  })

  it('rejects a request with no cookie', () => {
    const req = { cookies: {} } as any
    const res = makeRes()
    const next = vi.fn()

    requireAuth(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' })
  })

  it('rejects a malformed token', () => {
    const req = { cookies: { [JWT_COOKIE_NAME]: 'not-a-jwt' } } as any
    const res = makeRes()
    const next = vi.fn()

    requireAuth(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' })
  })

  it('rejects a token signed with the wrong secret', () => {
    // This is the test that catches the single most dangerous mistake here:
    // swapping jwt.verify for jwt.decode. decode() never checks the
    // signature, so a token forged with any secret would still parse and
    // this test would wrongly see next() called instead of a 401.
    const token = jwt.sign({ sub: 'user-1', role: 'USER' }, 'not-the-real-secret', { expiresIn: 60 })
    const req = { cookies: { [JWT_COOKIE_NAME]: token } } as any
    const res = makeRes()
    const next = vi.fn()

    requireAuth(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' })
  })

  it('rejects an expired token', () => {
    const token = jwt.sign({ sub: 'user-1', role: 'USER' }, JWT_SECRET, { expiresIn: -10 })
    const req = { cookies: { [JWT_COOKIE_NAME]: token } } as any
    const res = makeRes()
    const next = vi.fn()

    requireAuth(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' })
  })

  it('rejects a token with no sub claim', () => {
    const token = jwt.sign({ role: 'USER' }, JWT_SECRET, { expiresIn: 60 })
    const req = { cookies: { [JWT_COOKIE_NAME]: token } } as any
    const res = makeRes()
    const next = vi.fn()

    requireAuth(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' })
  })
})
