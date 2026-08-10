import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../apps/api/src/lib/auth', () => ({
  registerUser: vi.fn(),
  loginUser: vi.fn(),
  InvalidCredentialsError: class InvalidCredentialsError extends Error {},
  EmailAlreadyRegisteredError: class EmailAlreadyRegisteredError extends Error {},
}))

import { registerUser } from '../../../apps/api/src/lib/auth'
import { registerHandler } from '../../../apps/api/src/routes/auth'

const mockedRegisterUser = registerUser as unknown as ReturnType<typeof vi.fn>

function fakeRes() {
  const res: any = {}
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  return res
}

beforeEach(() => {
  mockedRegisterUser.mockReset()
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
