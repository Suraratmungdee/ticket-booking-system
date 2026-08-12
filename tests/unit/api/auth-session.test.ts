import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ userFindUnique: vi.fn(), loginUser: vi.fn() }))

vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: { user: { findUnique: m.userFindUnique } },
}))

vi.mock('../../../apps/api/src/lib/auth', () => ({
  registerUser: vi.fn(),
  loginUser: m.loginUser,
  InvalidCredentialsError: class InvalidCredentialsError extends Error {},
  EmailAlreadyRegisteredError: class EmailAlreadyRegisteredError extends Error {},
}))

import { meHandler, logoutHandler, loginHandler } from '../../../apps/api/src/routes/auth'
import { resetRateLimitState } from '../../../apps/api/src/lib/rate-limit'

function makeRes() {
  const res: any = {}
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  res.cookie = vi.fn().mockReturnValue(res)
  res.clearCookie = vi.fn().mockReturnValue(res)
  res.end = vi.fn().mockReturnValue(res)
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRateLimitState()
})

describe('meHandler', () => {
  it('reports the role stored in the database, not the one carried in the token', async () => {
    // The token says ADMIN: someone whose admin rights were revoked an hour
    // ago, still holding a JWT minted before the change. Tokens live two
    // hours, so trusting req.user.role would keep offering them the admin
    // nav for the rest of that window. This is the assertion that fails if
    // anyone "optimises away" the database read.
    m.userFindUnique.mockResolvedValue({
      id: 'u1',
      email: 'ann@example.com',
      name: 'Ann',
      role: 'USER',
    })
    const res = makeRes()

    await meHandler({ user: { id: 'u1', role: 'ADMIN' } } as never, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith({
      user: { id: 'u1', email: 'ann@example.com', name: 'Ann', role: 'USER' },
    })
  })

  it('returns 401 when the signature is valid but the account is gone', async () => {
    m.userFindUnique.mockResolvedValue(null)
    const res = makeRes()

    await meHandler({ user: { id: 'deleted', role: 'USER' } } as never, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' })
  })
})

describe('logoutHandler', () => {
  it('clears the cookie with the same attributes login set it with', async () => {
    // The failure this pins down is silent: a browser only drops a cookie
    // when name, secure, sameSite and httpOnly match what set it. Let the
    // two handlers drift apart and logout still answers 204 while the
    // session cookie stays in the jar — success-shaped, and wrong.
    m.loginUser.mockResolvedValue({ token: 'signed.jwt.value', user: { id: 'u1' } })
    const loginRes = makeRes()
    await loginHandler(
      { ip: '1.1.1.1', body: { email: 'ann@example.com', password: 'pw12345678' } } as never,
      loginRes,
      vi.fn(),
    )
    const [setName, , setOpts] = loginRes.cookie.mock.calls[0]

    const logoutRes = makeRes()
    logoutHandler({} as never, logoutRes, vi.fn())
    const [clearedName, clearOpts] = logoutRes.clearCookie.mock.calls[0]

    expect(clearedName).toBe(setName)
    expect(clearOpts.httpOnly).toBe(setOpts.httpOnly)
    expect(clearOpts.secure).toBe(setOpts.secure)
    expect(clearOpts.sameSite).toBe(setOpts.sameSite)
    expect(logoutRes.status).toHaveBeenCalledWith(204)
  })
})
