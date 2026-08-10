import Link from 'next/link'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

type EventListItem = {
  id: string
  title: string
  description: string
  venue: { id: string; name: string }
  showtimes: { id: string; startTime: string }[]
}

// Returns the event list on success, or `null` if the request failed
// (non-2xx response or a thrown network error) so the page can tell
// "backend error" apart from "zero results".
async function fetchEvents(searchParams: { date?: string; venueId?: string }): Promise<EventListItem[] | null> {
  const params = new URLSearchParams()
  if (searchParams.date) params.set('date', searchParams.date)
  if (searchParams.venueId) params.set('venueId', searchParams.venueId)

  try {
    const res = await fetch(`${API_URL}/events?${params.toString()}`, { cache: 'no-store' })
    if (!res.ok) {
      console.error(`GET /events failed with status ${res.status}`)
      return null
    }
    const data = await res.json()
    return data.events as EventListItem[]
  } catch (err) {
    console.error('GET /events failed', err)
    return null
  }
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; venueId?: string }>
}) {
  const params = await searchParams
  const events = await fetchEvents(params)

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-xl font-bold mb-4">รายการ Event</h1>

      <form method="get" className="flex gap-2 mb-6">
        <input
          type="date"
          name="date"
          defaultValue={params.date ?? ''}
          className="border p-2 rounded"
        />
        <input
          type="text"
          name="venueId"
          placeholder="Venue ID"
          defaultValue={params.venueId ?? ''}
          className="border p-2 rounded"
        />
        <button type="submit" className="bg-black text-white px-3 rounded">
          กรอง
        </button>
      </form>

      {events === null ? (
        <p className="text-red-600">เกิดข้อผิดพลาด ไม่สามารถโหลดรายการ event ได้ กรุณาลองใหม่อีกครั้ง</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {events.map((event) => (
            <li key={event.id} className="border rounded p-3">
              <Link href={`/events/${event.id}`} className="font-semibold underline">
                {event.title}
              </Link>
              <p className="text-sm text-gray-600">{event.venue.name}</p>
            </li>
          ))}
          {events.length === 0 && <p className="text-gray-500">ไม่พบ event</p>}
        </ul>
      )}
    </main>
  )
}
