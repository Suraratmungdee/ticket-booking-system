'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api'

export default function LoginPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = new FormData(e.currentTarget)

    const res = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: form.get('email'),
        password: form.get('password'),
      }),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(typeof data.error === 'string' ? data.error : 'เข้าสู่ระบบไม่สำเร็จ')
      return
    }

    router.push('/events')
  }

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-xl font-bold mb-4">เข้าสู่ระบบ</h1>
      {error && <p className="text-red-600 mb-2">{error}</p>}
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input
          name="email"
          type="email"
          placeholder="อีเมล"
          required
          className="border p-2 rounded"
        />
        <input
          name="password"
          type="password"
          placeholder="รหัสผ่าน"
          required
          className="border p-2 rounded"
        />
        <button type="submit" className="bg-black text-white p-2 rounded">
          เข้าสู่ระบบ
        </button>
      </form>
    </main>
  )
}
