import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { prisma } from './prisma.js'
import { BCRYPT_SALT_ROUNDS, JWT_SECRET, JWT_EXPIRES_IN } from './config.js'

export class InvalidCredentialsError extends Error {}
export class EmailAlreadyRegisteredError extends Error {}

export type PublicUser = {
  id: string
  email: string
  name: string
  role: string
}

function toPublicUser(user: { id: string; email: string; name: string; role: string }): PublicUser {
  return { id: user.id, email: user.email, name: user.name, role: user.role }
}

export async function registerUser(input: {
  email: string
  password: string
  name: string
}): Promise<PublicUser> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } })
  if (existing) throw new EmailAlreadyRegisteredError()

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_SALT_ROUNDS)
  const user = await prisma.user.create({
    data: { email: input.email, passwordHash, name: input.name },
  })
  return toPublicUser(user)
}

export async function loginUser(input: {
  email: string
  password: string
}): Promise<{ token: string; user: PublicUser }> {
  const user = await prisma.user.findUnique({ where: { email: input.email } })
  if (!user) throw new InvalidCredentialsError()

  const valid = await bcrypt.compare(input.password, user.passwordHash)
  if (!valid) throw new InvalidCredentialsError()

  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  })
  return { token, user: toPublicUser(user) }
}
