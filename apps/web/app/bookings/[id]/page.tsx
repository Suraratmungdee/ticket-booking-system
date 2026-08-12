'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
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
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

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

  async function handleCheckout() {
    if (submitting) return
    setSubmitting(true)
    setCheckoutError(null)

    let res: Response
    try {
      res = await apiFetch(`/bookings/${id}/checkout`, { method: 'POST' })
    } catch (err) {
      console.error(err)
      setCheckoutError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
      setSubmitting(false)
      return
    }

    if (res.status === 401) {
      router.push('/login')
      return
    }
    if (!res.ok) {
      // 409 covers "not yours", "not pending", and "hold expired" alike (see
      // apps/api/src/routes/bookings.ts) — the caller can't tell which, so
      // the message stays generic rather than guessing a reason.
      if (res.status === 409) {
        setCheckoutError('การจองนี้ไม่สามารถชำระเงินได้แล้ว')
      } else {
        setCheckoutError('เริ่มการชำระเงินไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
      }
      setSubmitting(false)
      return
    }

    const data = await res.json()
    // Full navigation, not router.push — checkoutUrl is the absolute URL a
    // real payment provider would hand back, not a Next.js route.
    window.location.href = data.checkoutUrl
  }

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

      {checkoutError && <p className="text-red-600">{checkoutError}</p>}

      {booking.status === 'PENDING_PAYMENT' && (
        <button
          type="button"
          onClick={handleCheckout}
          disabled={submitting}
          className="bg-black text-white p-2 rounded disabled:bg-gray-400"
        >
          {submitting ? 'กำลังไปหน้าชำระเงิน…' : 'ไปชำระเงิน'}
        </button>
      )}
      {booking.status === 'PAID' && (
        <>
          <p className="text-green-700">ชำระเงินสำเร็จแล้ว ขอบคุณที่ใช้บริการ</p>
          <Link href="/me/tickets" className="bg-black text-white p-2 rounded text-center">
            ดูตั๋วของฉัน
          </Link>
        </>
      )}
      {booking.status === 'EXPIRED' && (
        <p className="text-gray-600">การจองนี้หมดเวลาชำระเงินแล้ว กรุณาทำการจองใหม่</p>
      )}
      {booking.status === 'REFUND_REQUIRED' && (
        <p className="text-amber-700">
          การชำระเงินของคุณสำเร็จแล้ว แต่ที่นั่งที่จองไว้ถูกผู้อื่นจองไปก่อนในช่วงเวลาที่ทำรายการ
          ท่านจะได้รับเงินคืนเต็มจำนวน เจ้าหน้าที่จะติดต่อกลับเพื่อดำเนินการคืนเงินโดยเร็วที่สุด
        </p>
      )}
      {booking.status === 'CANCELLED' && (
        <p className="text-gray-600">การจองนี้ถูกยกเลิกแล้ว</p>
      )}
    </main>
  )
}
