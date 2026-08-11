import { prisma } from './prisma.js'
import { EMAIL_FROM, FRONTEND_ORIGIN } from './config.js'

type ConfirmationInput = {
  to: string
  bookingId: string
  eventTitle: string
  startTime: Date
  seats: string[]
  ticketUrl: string
}

// Resend's REST API directly over fetch. Their SDK wraps exactly this one
// POST — a dependency for ten lines is not worth the supply chain.
export async function sendBookingConfirmation(input: ConfirmationInput): Promise<void> {
  const when = input.startTime.toLocaleString('th-TH', { dateStyle: 'full', timeStyle: 'short' })
  const html =
    `<p>ยืนยันการจองเรียบร้อยแล้ว</p>` +
    `<p><strong>${input.eventTitle}</strong><br>${when}</p>` +
    `<p>ที่นั่ง: ${input.seats.join(', ')}</p>` +
    `<p>รหัสการจอง: ${input.bookingId}</p>` +
    `<p><a href="${input.ticketUrl}">เปิดตั๋วและ QR code</a></p>`

  // Read from process.env directly (not imported from config): tests swap
  // this variable between cases while config is evaluated once at import.
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    // Supported state, not a failure: local dev and CI have no mail account.
    // LIMITATION: this means "email works" is unverified until a real key is
    // configured in staging — say so rather than implying it was tested.
    console.info(`[email] would send booking confirmation to ${input.to}: ${input.ticketUrl}`)
    return
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [input.to],
      subject: `ยืนยันการจอง — ${input.eventTitle}`,
      html,
    }),
  })
  if (!res.ok) {
    throw new Error(`Resend rejected the message: ${res.status} ${await res.text()}`)
  }
}

// Loads what the confirmation needs and sends it. Separate from the pure
// function above so the route stays a thin adapter and the HTTP shape stays
// testable without a database.
export async function notifyBookingPaid(bookingId: string): Promise<void> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      user: { select: { email: true } },
      ticket: { select: { id: true } },
      showtime: { include: { event: { select: { title: true } } } },
      seats: { include: { seat: { select: { row: true, number: true } } } },
    },
  })
  // No ticket means this booking never actually became PAID — nothing to
  // confirm.
  if (!booking || !booking.ticket) return

  await sendBookingConfirmation({
    to: booking.user.email,
    bookingId: booking.id,
    eventTitle: booking.showtime.event.title,
    startTime: booking.showtime.startTime,
    seats: booking.seats.map((s) => `${s.seat.row}${s.seat.number}`),
    ticketUrl: `${FRONTEND_ORIGIN}/me/tickets/${booking.ticket.id}`,
  })
}
