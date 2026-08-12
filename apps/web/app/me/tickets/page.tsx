'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiFetch } from '@/lib/api'

type TicketListItem = {
  id: string
  issuedAt: string
  booking: {
    id: string
    showtime: { startTime: string; event: { title: string; venue: { name: string } } }
    seats: { seat: { row: string; number: number } }[]
  }
}

export default function MyTicketsPage() {
  const router = useRouter()
  const [tickets, setTickets] = useState<TicketListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let res: Response
      try {
        res = await apiFetch('/me/tickets')
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
        setError('โหลดตั๋วไม่สำเร็จ')
        return
      }
      const data = await res.json()
      setTickets(data.tickets)
    })()
    return () => {
      cancelled = true
    }
  }, [router])

  if (error) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <p className="text-red-600">{error}</p>
      </main>
    )
  }
  if (tickets === null) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <p>กำลังโหลด…</p>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-2xl p-8 flex flex-col gap-4">
      <h1 className="text-2xl font-bold">ตั๋วของฉัน</h1>

      {tickets.length === 0 ? (
        <p>
          ยังไม่มีตั๋ว{' '}
          <Link href="/events" className="underline">
            ดูรอบการแสดงทั้งหมด
          </Link>
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {tickets.map((t) => (
            <li key={t.id} className="border rounded p-4">
              <Link href={`/me/tickets/${t.id}`} className="flex flex-col gap-1">
                <span className="font-semibold">{t.booking.showtime.event.title}</span>
                <span className="text-sm">
                  {new Date(t.booking.showtime.startTime).toLocaleString('th-TH', {
                    dateStyle: 'full',
                    timeStyle: 'short',
                  })}
                </span>
                <span className="text-sm">{t.booking.showtime.event.venue.name}</span>
                <span className="text-sm">
                  ที่นั่ง: {t.booking.seats.map((s) => `${s.seat.row}${s.seat.number}`).join(', ')}
                </span>
                <span className="text-sm underline">เปิดตั๋ว</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
