'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import { Countdown } from './countdown'

type Booking = {
  id: string
  status: string
  totalPrice: number
  expiresAt: string
  showtime: { startTime: string; event: { title: string; venue: { name: string } } }
  seats: { seat: { row: string; number: number; seatMap: { zoneName: string } } }[]
}

export default function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [booking, setBooking] = useState<Booking | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let res: Response
      try {
        res = await apiFetch(`/bookings/${id}`)
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
        setError('ไม่พบการจองนี้')
        return
      }
      const data = await res.json()
      setBooking(data.booking)
    })()
    return () => {
      cancelled = true
    }
  }, [id, router])

  if (error) return <main className="mx-auto max-w-2xl p-8"><p className="text-red-600">{error}</p></main>
  if (!booking) return <main className="mx-auto max-w-2xl p-8"><p>กำลังโหลด…</p></main>

  return (
    <main className="mx-auto max-w-2xl p-8 flex flex-col gap-4">
      <h1 className="text-2xl font-bold">รายละเอียดการจอง</h1>

      <div className="border rounded p-4 flex flex-col gap-2">
        <p className="font-semibold">{booking.showtime.event.title}</p>
        <p className="text-gray-600">{booking.showtime.event.venue.name}</p>
        <p>รอบ {new Date(booking.showtime.startTime).toLocaleString('th-TH')}</p>
        <p>
          ที่นั่ง:{' '}
          {booking.seats
            .map((s) => `${s.seat.seatMap.zoneName} ${s.seat.row}${s.seat.number}`)
            .join(', ')}
        </p>
        <p>รวม {booking.totalPrice.toLocaleString('th-TH')} บาท</p>
        <p>สถานะ: {booking.status}</p>
        {booking.status === 'PENDING_PAYMENT' && (
          <p>
            เหลือเวลาชำระเงิน <Countdown expiresAt={booking.expiresAt} />
          </p>
        )}
      </div>

      <p className="text-sm text-gray-500">
        การชำระเงินจะเปิดให้ใช้งานใน Phase ถัดไป
      </p>
    </main>
  )
}
