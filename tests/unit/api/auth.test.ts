import { describe, it, expect, vi, beforeEach } from 'vitest'
import bcrypt from 'bcrypt'

vi.mock('../../../apps/api/src/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}))

import { prisma } from '../../../apps/api/src/lib/prisma'
import { loginUser, registerUser, InvalidCredentialsError, EmailAlreadyRegisteredError } from '../../../apps/api/src/lib/auth'

const mockedFindUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
const mockedCreate = prisma.user.create as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockedFindUnique.mockReset()
  mockedCreate.mockReset()
})

describe('loginUser', () => {
  it('returns a token and public user on correct password', async () => {
    const passwordHash = await bcrypt.hash('correct-horse', 10)
    mockedFindUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      passwordHash,
      name: 'Ann',
      role: 'USER',
    })

    const result = await loginUser({ email: 'a@b.com', password: 'correct-horse' })

    expect(result.token).toEqual(expect.any(String))
    expect(result.user).toEqual({ id: 'u1', email: 'a@b.com', name: 'Ann', role: 'USER' })
  })

  it('throws InvalidCredentialsError on wrong password', async () => {
    const passwordHash = await bcrypt.hash('correct-horse', 10)
    mockedFindUnique.mockResolvedValue({
      id: 'u1',
      email: 'a@b.com',
      passwordHash,
      name: 'Ann',
      role: 'USER',
    })

    await expect(loginUser({ email: 'a@b.com', password: 'wrong' })).rejects.toThrow(
      InvalidCredentialsError,
    )
  })

  it('throws InvalidCredentialsError when the email does not exist', async () => {
    mockedFindUnique.mockResolvedValue(null)

    await expect(
      loginUser({ email: 'nobody@b.com', password: 'anything' }),
    ).rejects.toThrow(InvalidCredentialsError)
  })
})

describe('registerUser', () => {
  it('throws EmailAlreadyRegisteredError when the email is taken', async () => {
    mockedFindUnique.mockResolvedValue({ id: 'u1' })

    await expect(
      registerUser({ email: 'a@b.com', password: 'pw12345678', name: 'Ann' }),
    ).rejects.toThrow(EmailAlreadyRegisteredError)
  })
})
