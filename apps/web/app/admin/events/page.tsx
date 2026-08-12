'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiFetch } from '@/lib/api'

type Venue = { id: string; name: string; address: string }
type EventRow = {
  id: string
  title: string
  description: string
  venue: { name: string }
  showtimes: { id: string }[]
}

export default function AdminEventsPage() {
  const router = useRouter()
  const [venues, setVenues] = useState<Venue[] | null>(null)
  const [events, setEvents] = useState<EventRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [venueName, setVenueName] = useState('')
  const [venueAddress, setVenueAddress] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [venueId, setVenueId] = useState('')

  async function load(): Promise<void> {
    let vres: Response
    let eres: Response
    try {
      ;[vres, eres] = await Promise.all([apiFetch('/admin/venues'), apiFetch('/admin/events')])
    } catch (err) {
      console.error(err)
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
      return
    }
    if (vres.status === 401 || eres.status === 401) {
      router.push('/login')
      return
    }
    if (vres.status === 404 || eres.status === 404) {
      router.push('/')
      return
    }
    if (!vres.ok || !eres.ok) {
      setError('โหลดข้อมูลไม่สำเร็จ')
      return
    }
    setVenues((await vres.json()).venues)
    setEvents((await eres.json()).events)
  }

  useEffect(() => {
    void load()
    // load() is defined in this component and only touches state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submit(path: string, body: unknown): Promise<boolean> {
    setSubmitting(true)
    setFormError(null)
    let res: Response
    try {
      res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) })
    } catch (err) {
      console.error(err)
      setFormError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
      setSubmitting(false)
      return false
    }
    setSubmitting(false)
    if (res.status === 401) {
      router.push('/login')
      return false
    }
    if (!res.ok) {
      setFormError('บันทึกไม่สำเร็จ กรุณาตรวจสอบข้อมูล')
      return false
    }
    return true
  }

  if (error) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="text-red-600">{error}</p>
      </main>
    )
  }
  if (venues === null || events === null) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p>กำลังโหลด…</p>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-3xl p-8 flex flex-col gap-8">
      <h1 className="text-2xl font-bold">จัดการ event</h1>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">เพิ่มสถานที่</h2>
        <label htmlFor="venue-name">ชื่อสถานที่</label>
        <input
          id="venue-name"
          value={venueName}
          onChange={(e) => setVenueName(e.target.value)}
          className="border p-2 rounded"
        />
        <label htmlFor="venue-address">ที่อยู่</label>
        <input
          id="venue-address"
          value={venueAddress}
          onChange={(e) => setVenueAddress(e.target.value)}
          className="border p-2 rounded"
        />
        <button
          type="button"
          disabled={submitting}
          onClick={async () => {
            if (await submit('/admin/venues', { name: venueName, address: venueAddress })) {
              setVenueName('')
              setVenueAddress('')
              await load()
            }
          }}
          className="bg-black text-white p-2 rounded disabled:bg-gray-400"
        >
          บันทึกสถานที่
        </button>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">เพิ่ม event</h2>
        <label htmlFor="event-title">ชื่อ event</label>
        <input
          id="event-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="border p-2 rounded"
        />
        <label htmlFor="event-description">รายละเอียด</label>
        <textarea
          id="event-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="border p-2 rounded"
        />
        <label htmlFor="event-venue">สถานที่</label>
        <select
          id="event-venue"
          value={venueId}
          onChange={(e) => setVenueId(e.target.value)}
          className="border p-2 rounded"
        >
          <option value="">เลือกสถานที่</option>
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={submitting}
          onClick={async () => {
            if (await submit('/admin/events', { title, description, venueId })) {
              setTitle('')
              setDescription('')
              setVenueId('')
              await load()
            }
          }}
          className="bg-black text-white p-2 rounded disabled:bg-gray-400"
        >
          บันทึก event
        </button>
        {formError && <p className="text-red-600">{formError}</p>}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">event ทั้งหมด</h2>
        <ul className="flex flex-col gap-2">
          {events.map((e) => (
            <li key={e.id} className="border rounded p-3">
              <div className="font-semibold">{e.title}</div>
              <div className="text-sm">{e.venue.name}</div>
              <div className="text-sm">{e.showtimes.length} รอบ</div>
              <Link href={`/admin/events/${e.id}/showtimes`} className="text-sm underline">
                จัดการรอบและผังที่นั่ง
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
