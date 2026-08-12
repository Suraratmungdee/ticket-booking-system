'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiFetch } from '@/lib/api'

type Ticket = {
  id: string
  issuedAt: string
  qrDataUrl: string
  booking: {
    id: string
    showtime: { startTime: string; event: { title: string; venue: { name: string } } }
    seats: { seat: { row: string; number: number; seatMap: { zoneName: string } } }[]
  }
}

export default function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let res: Response
      try {
        res = await apiFetch(`/tickets/${id}`)
      } catch (err) {
        console.error(err)
        if (!cancelled) setError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
        return
      }
      if (cancelled) return
      if (res.status === 401) {
        router.push('/login')
        return
      }
      if (!res.ok) {
        setError('ไม่พบตั๋วนี้')
        return
      }
      const data = await res.json()
      setTicket(data.ticket)
    })()
    return () => {
      cancelled = true
    }
  }, [id, router])

  if (error) {
    return (
      <main className="mx-auto max-w-sm p-8">
        <p className="text-red-600">{error}</p>
      </main>
    )
  }
  if (!ticket) {
    return (
      <main className="mx-auto max-w-sm p-8">
        <p>กำลังโหลด…</p>
      </main>
    )
  }

  const seats = ticket.booking.seats
    .map((s) => `${s.seat.seatMap.zoneName} ${s.seat.row}${s.seat.number}`)
    .join(', ')

  return (
    <main className="mx-auto max-w-sm p-8 flex flex-col gap-4">
      <h1 className="text-2xl font-bold">{ticket.booking.showtime.event.title}</h1>

      {/* alt carries the ticket code as text: the QR must not be the only
          way to identify this ticket for someone using a screen reader. */}
      <img
        src={ticket.qrDataUrl}
        alt={`QR code สำหรับตั๋วรหัส ${ticket.id}`}
        className="w-full max-w-[320px] self-center border rounded"
      />

      <dl className="flex flex-col gap-2 text-sm">
        <div>
          <dt className="font-semibold">รอบการแสดง</dt>
          <dd>
            {new Date(ticket.booking.showtime.startTime).toLocaleString('th-TH', {
              dateStyle: 'full',
              timeStyle: 'short',
            })}
          </dd>
        </div>
        <div>
          <dt className="font-semibold">สถานที่</dt>
          <dd>{ticket.booking.showtime.event.venue.name}</dd>
        </div>
        <div>
          <dt className="font-semibold">ที่นั่ง</dt>
          <dd>{seats}</dd>
        </div>
        <div>
          <dt className="font-semibold">รหัสตั๋ว</dt>
          <dd className="break-all font-mono">{ticket.id}</dd>
        </div>
      </dl>

      <Link href="/me/tickets" className="underline text-sm">
        ← กลับไปหน้าตั๋วของฉัน
      </Link>
    </main>
  )
}
