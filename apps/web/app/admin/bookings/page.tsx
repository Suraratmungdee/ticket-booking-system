'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api'

const STATUS_OPTIONS = [
  'PENDING_PAYMENT',
  'PAID',
  'EXPIRED',
  'CANCELLED',
  'REFUND_REQUIRED',
] as const

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'รอชำระเงิน',
  PAID: 'ชำระเงินแล้ว',
  EXPIRED: 'หมดเวลา',
  CANCELLED: 'ยกเลิกแล้ว',
  REFUND_REQUIRED: 'ต้องคืนเงิน',
}

type BookingRow = {
  id: string
  status: string
  totalPrice: number
  createdAt: string
  user: { email: string; name: string }
  showtime: { startTime: string; event: { title: string } }
  seats: { seat: { row: string; number: number } }[]
}

export default function AdminBookingsPage() {
  const router = useRouter()
  const [bookings, setBookings] = useState<BookingRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [emailFilter, setEmailFilter] = useState('')

  async function load(status: string, email: string): Promise<void> {
    const query = new URLSearchParams()
    if (status) query.set('status', status)
    if (email) query.set('email', email)
    const qs = query.toString()

    let res: Response
    try {
      res = await apiFetch(`/admin/bookings${qs ? `?${qs}` : ''}`)
    } catch (err) {
      console.error(err)
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
      return
    }
    if (res.status === 401) {
      router.push('/login')
      return
    }
    if (res.status === 404) {
      router.push('/')
      return
    }
    if (!res.ok) {
      setError('โหลดข้อมูลไม่สำเร็จ')
      return
    }
    const data = await res.json()
    setBookings(data.bookings)
  }

  useEffect(() => {
    void load('', '')
    // load() is defined in this component and only touches state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (error) {
    return (
      <main className="mx-auto max-w-5xl p-8">
        <p className="text-red-600">{error}</p>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-5xl p-8 flex flex-col gap-4">
      <h1 className="text-2xl font-bold">รายการจอง</h1>

      <p className="text-sm text-gray-600">
        การคืนเงินดำเนินการด้วยตนเองผ่านหน้าจัดการของผู้ให้บริการชำระเงิน หน้านี้จึงไม่มีปุ่มคืนเงิน
      </p>

      <form
        className="flex flex-wrap items-end gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void load(statusFilter, emailFilter)
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-status">สถานะ</label>
          <select
            id="filter-status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border p-2 rounded"
          >
            <option value="">ทั้งหมด</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-email">อีเมลลูกค้า</label>
          <input
            id="filter-email"
            value={emailFilter}
            onChange={(e) => setEmailFilter(e.target.value)}
            className="border p-2 rounded"
          />
        </div>
        <button type="submit" className="bg-black text-white p-2 rounded">
          ค้นหา
        </button>
      </form>

      {bookings === null ? (
        <p>กำลังโหลด…</p>
      ) : bookings.length === 0 ? (
        <p>ไม่พบรายการจอง</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left border-b">
                <th className="p-2">รหัสการจอง</th>
                <th className="p-2">อีเมลลูกค้า</th>
                <th className="p-2">Event</th>
                <th className="p-2">รอบ</th>
                <th className="p-2">ที่นั่ง</th>
                <th className="p-2">ราคารวม</th>
                <th className="p-2">สถานะ</th>
                <th className="p-2">วันที่จอง</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id} className="border-b">
                  <td className="p-2">{b.id}</td>
                  <td className="p-2">{b.user.email}</td>
                  <td className="p-2">{b.showtime.event.title}</td>
                  <td className="p-2">
                    {new Date(b.showtime.startTime).toLocaleString('th-TH')}
                  </td>
                  <td className="p-2">
                    {b.seats.map((s) => `${s.seat.row}${s.seat.number}`).join(', ')}
                  </td>
                  <td className="p-2">{b.totalPrice.toLocaleString('th-TH')} บาท</td>
                  <td className="p-2">
                    {b.status === 'REFUND_REQUIRED' ? (
                      <span className="text-red-600 font-semibold">
                        {STATUS_LABEL[b.status]} (ต้องดำเนินการคืนเงิน)
                      </span>
                    ) : (
                      <span>{STATUS_LABEL[b.status] ?? b.status}</span>
                    )}
                  </td>
                  <td className="p-2">{new Date(b.createdAt).toLocaleString('th-TH')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
