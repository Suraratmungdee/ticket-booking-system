import { test, expect } from '@playwright/test'
import { prisma } from '../../apps/api/src/lib/prisma'
import { createFixture, deleteFixture, type TestFixture } from '../integration/helpers'

// Reuses the same scoped-fixture helper the concurrency integration tests
// use (see tests/integration/helpers.ts): its own Venue → Event → Showtime
// → SeatMap → Seat chain, torn down after, never touching seeded or
// another test's rows.
let fixture: TestFixture
const email = `e2e-${Date.now()}@example.com`
const password = 'e2e-golden-path-pw'

test.beforeAll(async () => {
  fixture = await createFixture('e2e-golden-path')
})

test.afterAll(async () => {
  // deleteFixture only knows about the 20 users it created itself — this
  // test's booking belongs to the user registered through the UI, so its
  // Ticket/Payment/BookingSeat/Booking chain has to be cleared by hand
  // first, in the same child-to-parent order deleteFixture uses, or the
  // showtime delete inside deleteFixture hits a live FK reference.
  const user = await prisma.user.findUnique({ where: { email } })
  if (user) {
    const bookings = await prisma.booking.findMany({ where: { userId: user.id }, select: { id: true } })
    const bookingIds = bookings.map((b) => b.id)
    await prisma.ticket.deleteMany({ where: { bookingId: { in: bookingIds } } })
    await prisma.payment.deleteMany({ where: { bookingId: { in: bookingIds } } })
    await prisma.bookingSeat.deleteMany({ where: { bookingId: { in: bookingIds } } })
    await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } })
    await prisma.user.delete({ where: { id: user.id } })
  }
  await deleteFixture(fixture)
  await prisma.$disconnect()
})

// The one flow CLAUDE.md §2 and the project plan call out as needing a real
// browser: search → pick a seat → pay → land on an actual ticket. Every
// branch along the way already has unit/integration coverage in isolation;
// this is the only test proving they still connect once real HTTP and real
// pages sit between them.
test('search an event, book a seat, pay, and see the issued ticket', async ({ page }) => {
  await page.goto('/register')
  await page.getByLabel('ชื่อ').fill('E2E Tester')
  await page.getByLabel('อีเมล').fill(email)
  await page.getByLabel('รหัสผ่าน (8 ตัวขึ้นไป)').fill(password)
  await page.getByRole('button', { name: 'สมัครสมาชิก' }).click()
  await expect(page).toHaveURL(/\/login$/)

  await page.getByLabel('อีเมล').fill(email)
  await page.getByLabel('รหัสผ่าน').fill(password)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page).toHaveURL(/\/events$/)

  // Prove the fixture event is actually findable through the real search
  // page before jumping to it by id.
  await expect(page.getByRole('link', { name: /e2e-golden-path event/ }).first()).toBeVisible()

  await page.goto(`/events/${fixture.eventId}`)
  await page.locator('a[href*="/showtimes/"]').first().click()
  await expect(page).toHaveURL(new RegExp(`/showtimes/${fixture.showtimeId}/seats`))

  await page.getByRole('button', { name: /แถว A ที่ 1/ }).click()
  await page.getByRole('button', { name: 'จองที่นั่ง' }).click()
  await expect(page).toHaveURL(/\/bookings\//)

  await page.getByRole('button', { name: 'ไปชำระเงิน' }).click()
  await expect(page).toHaveURL(/\/mock-pay\//)
  await page.getByRole('button', { name: 'จ่ายเงินสำเร็จ' }).click()

  await expect(page).toHaveURL(/\/bookings\//)
  await expect(page.getByText('ชำระเงินสำเร็จแล้ว ขอบคุณที่ใช้บริการ')).toBeVisible()

  await page.getByRole('link', { name: 'ดูตั๋วของฉัน' }).click()
  await expect(page).toHaveURL(/\/me\/tickets$/)

  await page.getByRole('link', { name: /e2e-golden-path event/ }).click()
  await expect(page).toHaveURL(/\/me\/tickets\//)
  await expect(page.getByAltText(/QR code/)).toBeVisible()
})
