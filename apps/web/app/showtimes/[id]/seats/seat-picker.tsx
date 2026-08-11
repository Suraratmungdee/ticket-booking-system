'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api'

type Seat = { id: string; row: string; number: number; status: 'AVAILABLE' | 'HELD' | 'BOOKED' }
type Zone = { zoneName: string; price: number; seats: Seat[] }

// Status is never conveyed by colour alone — each state also carries a symbol
// and a text label, so it stays readable for colour-blind users.
const SEAT_STYLE: Record<Seat['status'], { className: string; symbol: string; label: string }> = {
  AVAILABLE: { className: 'bg-white border-gray-400 hover:border-black', symbol: '', label: 'ว่าง' },
  HELD: { className: 'bg-yellow-100 border-yellow-500 text-yellow-800 cursor-not-allowed', symbol: '⏳', label: 'มีคนกำลังจอง' },
  BOOKED: { className: 'bg-gray-300 border-gray-400 text-gray-500 cursor-not-allowed', symbol: '✕', label: 'ถูกจองแล้ว' },
}

// MAX_SEATS comes from the server (config.ts's MAX_SEATS_PER_BOOKING via the
// seat-map response) rather than being restated here — one source of truth
// for the business rule, per CLAUDE.md §4.3.
export function SeatPicker({
  showtimeId,
  zones,
  maxSeats,
}: {
  showtimeId: string
  zones: Zone[]
  maxSeats: number
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const priceOf = (seatId: string) =>
    zones.find((z) => z.seats.some((s) => s.id === seatId))?.price ?? 0
  // Display only — the server recomputes the real total from the database.
  const total = [...selected].reduce((sum, id) => sum + priceOf(id), 0)

  function toggle(seat: Seat) {
    if (seat.status !== 'AVAILABLE') return
    setError(null)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(seat.id)) next.delete(seat.id)
      else if (next.size >= maxSeats) return prev
      else next.add(seat.id)
      return next
    })
  }

  async function handleSubmit() {
    if (selected.size === 0 || submitting) return
    setSubmitting(true)
    setError(null)

    let res: Response
    try {
      res = await apiFetch(`/showtimes/${showtimeId}/seats/hold`, {
        method: 'POST',
        body: JSON.stringify({ seatIds: [...selected] }),
      })
    } catch (err) {
      console.error(err)
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
      setSubmitting(false)
      return
    }

    if (res.status === 401) {
      router.push('/login')
      return
    }
    if (!res.ok) {
      // Keyed off the status, not the shape of the error body — a 500 also
      // returns { error: string }, and it is not "seats taken".
      if (res.status === 409) {
        setError('ที่นั่งบางที่ถูกจองไปแล้ว กรุณาเลือกใหม่')
        // The seats that were just taken may be among `selected` — clear it
        // so they stop counting toward the displayed total after refresh.
        setSelected(new Set())
      } else {
        setError('จองไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
      }
      setSubmitting(false)
      router.refresh()
      return
    }

    const data = await res.json()
    router.push(`/bookings/${data.booking.id}`)
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-red-600">{error}</p>}

      <ul className="flex flex-wrap gap-4 text-sm">
        {(Object.keys(SEAT_STYLE) as Seat['status'][]).map((status) => (
          <li key={status} className="flex items-center gap-2">
            <span className={`inline-block h-5 w-5 rounded border ${SEAT_STYLE[status].className}`} />
            {SEAT_STYLE[status].label}
          </li>
        ))}
      </ul>

      {zones.map((zone) => (
        <section key={zone.zoneName}>
          <h2 className="font-semibold mb-2">
            {zone.zoneName} — {zone.price.toLocaleString('th-TH')} บาท
          </h2>
          <div className="flex flex-col gap-1">
            {Object.entries(
              zone.seats.reduce<Record<string, Seat[]>>((rows, seat) => {
                ;(rows[seat.row] ??= []).push(seat)
                return rows
              }, {}),
            ).map(([row, seats]) => (
              <div key={row} className="flex items-center gap-1">
                <span className="w-5 text-sm text-gray-500">{row}</span>
                {seats.map((seat) => {
                  const isSelected = selected.has(seat.id)
                  const style = SEAT_STYLE[seat.status]
                  return (
                    <button
                      key={seat.id}
                      type="button"
                      onClick={() => toggle(seat)}
                      disabled={seat.status !== 'AVAILABLE'}
                      aria-pressed={isSelected}
                      aria-label={`แถว ${seat.row} ที่ ${seat.number} — ${isSelected ? 'เลือกแล้ว' : style.label}`}
                      className={`h-11 w-11 rounded border text-xs ${
                        isSelected ? 'bg-black text-white border-black' : style.className
                      }`}
                    >
                      {isSelected ? '✓' : (style.symbol || seat.number)}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </section>
      ))}

      <div className="sticky bottom-0 bg-white border-t py-3 flex items-center justify-between">
        <p>
          เลือก {selected.size} ที่ · รวม {total.toLocaleString('th-TH')} บาท
        </p>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={selected.size === 0 || submitting}
          className="bg-black text-white px-4 py-2 rounded disabled:bg-gray-400"
        >
          {submitting ? 'กำลังจอง…' : 'จองที่นั่ง'}
        </button>
      </div>
    </div>
  )
}
