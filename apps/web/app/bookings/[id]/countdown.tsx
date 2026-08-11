'use client'

import { useEffect, useState } from 'react'

export function Countdown({ expiresAt }: { expiresAt: string }) {
  const [remaining, setRemaining] = useState(() => Date.parse(expiresAt) - Date.now())

  useEffect(() => {
    const timer = setInterval(() => setRemaining(Date.parse(expiresAt) - Date.now()), 1000)
    return () => clearInterval(timer)
  }, [expiresAt])

  if (remaining <= 0) return <span className="text-red-600">หมดเวลาแล้ว</span>

  const minutes = Math.floor(remaining / 60000)
  const seconds = Math.floor((remaining % 60000) / 1000)
  return (
    <span className="font-mono">
      {minutes}:{String(seconds).padStart(2, '0')}
    </span>
  )
}
