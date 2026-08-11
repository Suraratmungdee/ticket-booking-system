'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api'

// Stands in for a real payment provider's hosted checkout page. A real
// provider has no session with us, so this page deliberately does NOT
// require login and shows nothing but the amount due — no booking details,
// no user info. The dashed border and banner make it unmistakable that this
// is a simulated screen, not a live payment form.
export default function MockPayPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = use(params)
  const router = useRouter()
  const [amount, setAmount] = useState<number | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let res: Response
      try {
        res = await apiFetch(`/mock-provider/sessions/${ref}`)
      } catch (err) {
        console.error(err)
        if (!cancelled) setLoadError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
        return
      }
      if (cancelled) return
      if (!res.ok) {
        setLoadError('ไม่พบรายการชำระเงินนี้')
        return
      }
      const data = await res.json()
      setAmount(data.amount)
    })()
    return () => {
      cancelled = true
    }
  }, [ref])

  async function complete(outcome: 'succeeded' | 'failed') {
    if (submitting) return
    setSubmitting(true)
    setActionError(null)

    let res: Response
    try {
      res = await apiFetch(`/mock-provider/sessions/${ref}/complete`, {
        method: 'POST',
        body: JSON.stringify({ outcome }),
      })
    } catch (err) {
      console.error(err)
      setActionError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
      setSubmitting(false)
      return
    }

    if (!res.ok) {
      setActionError('ทำรายการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
      setSubmitting(false)
      return
    }

    const data = await res.json()
    router.push(`/bookings/${data.bookingId}`)
  }

  if (loadError) {
    return (
      <main className="mx-auto max-w-sm p-8">
        <p className="text-red-600">{loadError}</p>
      </main>
    )
  }
  if (amount === null) {
    return (
      <main className="mx-auto max-w-sm p-8">
        <p>กำลังโหลด…</p>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-sm p-8 mt-8 flex flex-col gap-4 border-4 border-dashed border-amber-500 rounded">
      <p className="text-xs uppercase tracking-wide text-amber-700 font-semibold">
        หน้าจำลองการชำระเงิน — ไม่ใช่ผู้ให้บริการชำระเงินจริง
      </p>
      <h1 className="text-xl font-bold">ยืนยันการชำระเงิน</h1>
      <p className="text-3xl font-bold">{amount.toLocaleString('th-TH')} บาท</p>

      {actionError && <p className="text-red-600">{actionError}</p>}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => complete('succeeded')}
          disabled={submitting}
          className="bg-black text-white p-2 rounded disabled:bg-gray-400"
        >
          {submitting ? 'กำลังดำเนินการ…' : 'จ่ายเงินสำเร็จ'}
        </button>
        <button
          type="button"
          onClick={() => complete('failed')}
          disabled={submitting}
          className="border border-black p-2 rounded disabled:opacity-50"
        >
          จ่ายเงินไม่สำเร็จ
        </button>
      </div>
    </main>
  )
}
