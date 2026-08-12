'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiFetch } from '@/lib/api'

type Row = {
  showtimeId: string
  eventTitle: string
  startTime: string
  totalSeats: number
  occupiedSeats: number
  revenue: number
}

export default function AdminDashboardPage() {
  const router = useRouter()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let res: Response
      try {
        res = await apiFetch('/admin/dashboard')
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
      // The API answers 404 to anyone who is not an admin.
      if (res.status === 404) {
        router.push('/')
        return
      }
      if (!res.ok) {
        setError('โหลดข้อมูลไม่สำเร็จ')
        return
      }
      const data = await res.json()
      if (cancelled) return
      setRows(data.showtimes)
    })()
    return () => {
      cancelled = true
    }
  }, [router])

  if (error) {
    return (
      <main className="mx-auto max-w-4xl p-8">
        <p className="text-red-600">{error}</p>
      </main>
    )
  }
  if (rows === null) {
    return (
      <main className="mx-auto max-w-4xl p-8">
        <p>กำลังโหลด…</p>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-4xl p-8 flex flex-col gap-4">
      <h1 className="text-2xl font-bold">ภาพรวม</h1>
      <nav className="flex gap-4 text-sm">
        <Link href="/admin/events" className="underline">
          จัดการ event
        </Link>
        <Link href="/admin/bookings" className="underline">
          รายการจอง
        </Link>
      </nav>

      {rows.length === 0 ? (
        <p>ยังไม่มีรอบการแสดง</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left border-b">
                <th className="p-2">รอบ</th>
                <th className="p-2">เวลาเริ่ม</th>
                <th className="p-2">ที่นั่งทั้งหมด</th>
                <th className="p-2">ที่นั่งไม่ว่าง</th>
                <th className="p-2">ยอดขาย (จ่ายแล้ว)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.showtimeId} className="border-b">
                  <td className="p-2">{r.eventTitle}</td>
                  <td className="p-2">
                    {new Date(r.startTime).toLocaleString('th-TH', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </td>
                  <td className="p-2">{r.totalSeats}</td>
                  <td className="p-2">{r.occupiedSeats}</td>
                  <td className="p-2">{r.revenue.toLocaleString('th-TH')} บาท</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* The two figures count different things — see lib/admin.ts. Saying so
          on screen stops someone reporting a bug that is not one. */}
      <p className="text-xs text-gray-600">
        “ที่นั่งไม่ว่าง” นับรวมที่นั่งที่ถูกจองไว้แต่ยังไม่ได้ชำระเงิน ส่วน “ยอดขาย”
        นับเฉพาะการจองที่ชำระเงินแล้ว ตัวเลขสองคอลัมน์นี้จึงไม่จำเป็นต้องสอดคล้องกัน
      </p>
    </main>
  )
}
