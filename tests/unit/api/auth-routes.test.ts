import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../apps/api/src/lib/auth', () => ({
  registerUser: vi.fn(),
  loginUser: vi.fn(),
  InvalidCredentialsError: class InvalidCredentialsError extends Error {},
  EmailAlreadyRegisteredError: class EmailAlreadyRegisteredError extends Error {},
}))

import { registerUser, loginUser, InvalidCredentialsError } from '../../../apps/api/src/lib/auth'
import { registerHandler, loginHandler } from '../../../apps/api/src/routes/auth'
import { resetRateLimitState } from '../../../apps/api/src/lib/rate-limit'
import { LOGIN_RATE_LIMIT_MAX } from '../../../apps/api/src/lib/config'

const mockedRegisterUser = registerUser as unknown as ReturnType<typeof vi.fn>
const mockedLoginUser = loginUser as unknown as ReturnType<typeof vi.fn>

function fakeRes() {
  const res: any = {}
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  res.cookie = vi.fn().mockReturnValue(res)
  return res
}

beforeEach(() => {
  mockedRegisterUser.mockReset()
  mockedLoginUser.mockReset()
  resetRateLimitState()
})

describe('registerHandler', () => {
  it('returns 409 when registerUser rejects with a raw Prisma P2002 unique-constraint error', async () => {
    // Simulates the register race: registerUser's existence check and create()
    // aren't atomic, so a concurrent duplicate registration can surface as a
    // raw Prisma error instead of EmailAlreadyRegisteredError. The handler
    // must still respond with the same 409 a non-racing duplicate gets.
    mockedRegisterUser.mockRejectedValue({ code: 'P2002' })
    const req: any = { body: { email: 'a@b.com', password: 'pw12345678', name: 'Ann' } }
    const res = fakeRes()

    await registerHandler(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: 'Email already registered' })
  })
})

describe('loginHandler rate limiting', () => {
  it('returns 401 for each failed attempt up to the limit, then 429 for the next one', async () => {
    mockedLoginUser.mockRejectedValue(new InvalidCredentialsError())
    const req: any = { ip: '9.9.9.9', body: { email: 'a@b.com', password: 'wrong' } }

    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) {
      const res = fakeRes()
      await loginHandler(req, res, vi.fn())
      expect(res.status).toHaveBeenCalledWith(401)
    }

    // This is the assertion that fails if the limit check is deleted: with
    // no limiter, this next attempt would also 401 (loginUser keeps
    // rejecting), never 429.
    const blockedRes = fakeRes()
    await loginHandler(req, blockedRes, vi.fn())
    expect(blockedRes.status).toHaveBeenCalledWith(429)
    expect(mockedLoginUser).toHaveBeenCalledTimes(LOGIN_RATE_LIMIT_MAX)
  })

  it('does not consume rate-limit budget on successful logins', async () => {
    mockedLoginUser.mockResolvedValue({
      token: 'jwt-token',
      user: { id: 'u1', email: 'a@b.com', name: 'Ann', role: 'USER' },
    })
    const req: any = { ip: '8.8.8.8', body: { email: 'a@b.com', password: 'correct' } }

    // Well beyond the failure limit — since every attempt succeeds, none of
    // them should count against the budget.
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX + 5; i++) {
      const res = fakeRes()
      await loginHandler(req, res, vi.fn())
      expect(res.status).not.toHaveBeenCalledWith(429)
      expect(res.json).toHaveBeenCalledWith({ user: { id: 'u1', email: 'a@b.com', name: 'Ann', role: 'USER' } })
    }
  })

  it('tracks separate IPs independently', async () => {
    mockedLoginUser.mockRejectedValue(new InvalidCredentialsError())
    const attacker: any = { ip: '1.1.1.1', body: { email: 'a@b.com', password: 'wrong' } }
    const bystander: any = { ip: '2.2.2.2', body: { email: 'a@b.com', password: 'wrong' } }

    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) {
      await loginHandler(attacker, fakeRes(), vi.fn())
    }
    const blockedRes = fakeRes()
    await loginHandler(attacker, blockedRes, vi.fn())
    expect(blockedRes.status).toHaveBeenCalledWith(429)

    const bystanderRes = fakeRes()
    await loginHandler(bystander, bystanderRes, vi.fn())
    expect(bystanderRes.status).toHaveBeenCalledWith(401)
  })
})
