import { API_URL } from '@/lib/api'
import { SeatPicker } from './seat-picker'

type Zone = {
  zoneName: string
  price: number
  seats: { id: string; row: string; number: number; status: 'AVAILABLE' | 'HELD' | 'BOOKED' }[]
}

type SeatMapResponse = { zones: Zone[]; maxSeatsPerBooking: number }

async function fetchSeatMap(showtimeId: string): Promise<SeatMapResponse | null> {
  try {
    const res = await fetch(`${API_URL}/showtimes/${showtimeId}/seats`, { cache: 'no-store' })
    if (!res.ok) return null
    const data = await res.json()
    if (!Array.isArray(data.zones) || typeof data.maxSeatsPerBooking !== 'number') return null
    return { zones: data.zones, maxSeatsPerBooking: data.maxSeatsPerBooking }
  } catch (err) {
    console.error(err)
    return null
  }
}

export default async function SeatsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const seatMap = await fetchSeatMap(id)

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-bold mb-4">เลือกที่นั่ง</h1>
      {seatMap === null ? (
        <p className="text-red-600">โหลดผังที่นั่งไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</p>
      ) : seatMap.zones.length === 0 ? (
        <p className="text-gray-500">รอบนี้ยังไม่มีผังที่นั่ง</p>
      ) : (
        <SeatPicker showtimeId={id} zones={seatMap.zones} maxSeats={seatMap.maxSeatsPerBooking} />
      )}
    </main>
  )
}
