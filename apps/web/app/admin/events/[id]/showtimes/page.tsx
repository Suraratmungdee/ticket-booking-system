'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiFetch } from '@/lib/api'

type Showtime = {
  id: string
  eventId: string
  startTime: string
  endTime: string
  status: string
}
type EventDetail = {
  id: string
  title: string
  description: string
  venue: { id: string; name: string; address: string }
  showtimes: Showtime[]
}

export default function AdminEventShowtimesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [event, setEvent] = useState<EventDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')

  const [seatShowtimeId, setSeatShowtimeId] = useState('')
  const [zoneName, setZoneName] = useState('')
  const [price, setPrice] = useState('')
  const [rowsText, setRowsText] = useState('')
  const [seatsPerRow, setSeatsPerRow] = useState('')

  async function load(): Promise<void> {
    let res: Response
    try {
      res = await apiFetch('/admin/events')
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
    // Display concern, not business logic: the API returns every event, and
    // this page shows the one the route already names.
    const found = (data.events as EventDetail[]).find((e) => e.id === id)
    if (!found) {
      setNotFound(true)
      return
    }
    setEvent(found)
  }

  useEffect(() => {
    void load()
    // load() is defined in this component and only touches state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function submit(path: string, body: unknown): Promise<{ ok: boolean; message?: string }> {
    setSubmitting(true)
    setFormError(null)
    let res: Response
    try {
      res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) })
    } catch (err) {
      console.error(err)
      setSubmitting(false)
      return { ok: false, message: 'เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' }
    }
    setSubmitting(false)
    if (res.status === 401) {
      router.push('/login')
      return { ok: false }
    }
    if (!res.ok) {
      // Surface the server's own message when it sent a plain string (e.g.
      // the seat-map cap). Zod validation errors come back as an object, not
      // a string — those fall back to a generic Thai message rather than
      // rendering "[object Object]".
      let message = 'บันทึกไม่สำเร็จ กรุณาตรวจสอบข้อมูล'
      try {
        const data = await res.json()
        if (typeof data.error === 'string') message = data.error
      } catch (err) {
        console.error(err)
      }
      return { ok: false, message }
    }
    return { ok: true }
  }

  const rows = rowsText
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
  const seatsPerRowNum = Number(seatsPerRow)
  const seatCount =
    rows.length > 0 && Number.isFinite(seatsPerRowNum) && seatsPerRowNum > 0
      ? rows.length * seatsPerRowNum
      : 0

  if (error) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="text-red-600">{error}</p>
      </main>
    )
  }
  if (notFound) {
    return (
      <main className="mx-auto max-w-3xl p-8 flex flex-col gap-4">
        <p>ไม่พบ event นี้</p>
        <Link href="/admin/events" className="underline text-sm">
          กลับไปหน้าจัดการ event
        </Link>
      </main>
    )
  }
  if (event === null) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p>กำลังโหลด…</p>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-3xl p-8 flex flex-col gap-8">
      <div>
        <Link href="/admin/events" className="text-sm underline">
          &larr; event ทั้งหมด
        </Link>
        <h1 className="text-2xl font-bold">{event.title}</h1>
        <p className="text-sm text-gray-600">{event.venue.name}</p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">เพิ่มรอบการแสดง</h2>
        <label htmlFor="showtime-start">เวลาเริ่ม</label>
        <input
          id="showtime-start"
          type="datetime-local"
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          className="border p-2 rounded"
        />
        <label htmlFor="showtime-end">เวลาสิ้นสุด</label>
        <input
          id="showtime-end"
          type="datetime-local"
          value={endTime}
          onChange={(e) => setEndTime(e.target.value)}
          className="border p-2 rounded"
        />
        <button
          type="button"
          disabled={submitting}
          onClick={async () => {
            const result = await submit('/admin/showtimes', {
              eventId: id,
              startTime: new Date(startTime).toISOString(),
              endTime: new Date(endTime).toISOString(),
            })
            if (result.ok) {
              setStartTime('')
              setEndTime('')
              await load()
            } else if (result.message) {
              setFormError(result.message)
            }
          }}
          className="bg-black text-white p-2 rounded disabled:bg-gray-400"
        >
          บันทึกรอบการแสดง
        </button>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">รอบการแสดงทั้งหมด</h2>
        {event.showtimes.length === 0 ? (
          <p>ยังไม่มีรอบการแสดง</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {event.showtimes.map((s) => (
              <li key={s.id} className="border rounded p-3 text-sm">
                {new Date(s.startTime).toLocaleString('th-TH')} &ndash;{' '}
                {new Date(s.endTime).toLocaleString('th-TH')}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">เพิ่มผังที่นั่ง</h2>
        <label htmlFor="seatmap-showtime">รอบการแสดง</label>
        <select
          id="seatmap-showtime"
          value={seatShowtimeId}
          onChange={(e) => setSeatShowtimeId(e.target.value)}
          className="border p-2 rounded"
        >
          <option value="">เลือกรอบการแสดง</option>
          {event.showtimes.map((s) => (
            <option key={s.id} value={s.id}>
              {new Date(s.startTime).toLocaleString('th-TH')}
            </option>
          ))}
        </select>
        <label htmlFor="seatmap-zone">ชื่อโซน</label>
        <input
          id="seatmap-zone"
          value={zoneName}
          onChange={(e) => setZoneName(e.target.value)}
          className="border p-2 rounded"
        />
        <label htmlFor="seatmap-price">ราคา (บาท)</label>
        <input
          id="seatmap-price"
          type="number"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          className="border p-2 rounded"
        />
        <label htmlFor="seatmap-rows">แถว (คั่นด้วยจุลภาค เช่น A,B,C)</label>
        <input
          id="seatmap-rows"
          value={rowsText}
          onChange={(e) => setRowsText(e.target.value)}
          className="border p-2 rounded"
        />
        <label htmlFor="seatmap-seats-per-row">จำนวนที่นั่งต่อแถว</label>
        <input
          id="seatmap-seats-per-row"
          type="number"
          value={seatsPerRow}
          onChange={(e) => setSeatsPerRow(e.target.value)}
          className="border p-2 rounded"
        />
        <p className="text-sm text-gray-600">รวม {seatCount} ที่นั่ง</p>
        <button
          type="button"
          disabled={submitting}
          onClick={async () => {
            const result = await submit('/admin/seatmaps', {
              showtimeId: seatShowtimeId,
              zoneName,
              price: Number(price),
              rows,
              seatsPerRow: seatsPerRowNum,
            })
            if (result.ok) {
              setZoneName('')
              setPrice('')
              setRowsText('')
              setSeatsPerRow('')
              await load()
            } else if (result.message) {
              setFormError(result.message)
            }
          }}
          className="bg-black text-white p-2 rounded disabled:bg-gray-400"
        >
          บันทึกผังที่นั่ง
        </button>
        {formError && <p className="text-red-600">{formError}</p>}
      </section>
    </main>
  )
}
