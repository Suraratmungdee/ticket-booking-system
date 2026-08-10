import { notFound } from 'next/navigation'
import { API_URL } from '../../../lib/api'

type EventDetail = {
  id: string
  title: string
  description: string
  venue: { id: string; name: string; address: string }
  showtimes: { id: string; startTime: string; endTime: string; status: string }[]
}

// Returns the event on success, `null` on a 404 (caller calls notFound()),
// or throws on any other failure (non-2xx response or a thrown network
// error) so the page can tell "not found" apart from "backend error".
async function fetchEvent(id: string): Promise<EventDetail | null> {
  const res = await fetch(`${API_URL}/events/${id}`, { cache: 'no-store' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET /events/${id} failed with status ${res.status}`)
  const data = await res.json()
  // A 200 body without a usable `event` object is a backend bug, not a
  // "not found" — throw so it takes the error-message path below instead of
  // being treated as null and reaching notFound() for the wrong reason.
  // `typeof x === 'object'` alone also passes arrays and `{}`, so check the
  // two fields the render below actually dereferences (event.venue.name and
  // event.showtimes.map) rather than just "is it an object".
  if (!data?.event?.venue || !Array.isArray(data.event.showtimes)) {
    throw new Error(`GET /events/${id} returned a malformed body`)
  }
  return data.event as EventDetail
}

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  let event: EventDetail | null
  try {
    event = await fetchEvent(id)
  } catch (err) {
    console.error('GET /events/:id failed', err)
    return (
      <main className="mx-auto max-w-2xl p-8">
        <p className="text-red-600">เกิดข้อผิดพลาด ไม่สามารถโหลดข้อมูล event ได้ กรุณาลองใหม่อีกครั้ง</p>
      </main>
    )
  }

  if (!event) notFound()

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-bold">{event.title}</h1>
      <p className="text-gray-600">{event.venue.name} — {event.venue.address}</p>
      <p className="mt-4">{event.description}</p>

      <h2 className="text-lg font-semibold mt-6 mb-2">รอบที่มี</h2>
      <ul className="flex flex-col gap-2">
        {event.showtimes.map((showtime) => (
          <li key={showtime.id} className="border rounded p-3">
            {new Date(showtime.startTime).toLocaleString('th-TH')} —{' '}
            {new Date(showtime.endTime).toLocaleString('th-TH')} ({showtime.status})
          </li>
        ))}
        {event.showtimes.length === 0 && <p className="text-gray-500">ยังไม่มีรอบ</p>}
      </ul>
    </main>
  )
}
