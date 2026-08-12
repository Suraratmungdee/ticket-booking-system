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

    let res: Response
    try {
      res = await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: form.get('email'),
          password: form.get('password'),
        }),
      })
    } catch (err) {
      console.error(err)
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
      return
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(typeof data.error === 'string' ? data.error : 'เข้าสู่ระบบไม่สำเร็จ')
      return
    }

    // Land people where they actually work. The role comes from the login
    // response, which is only a display hint — every /admin route is still
    // guarded server-side, so a forged role here buys nothing but a 404.
    const data = await res.json().catch(() => ({}))
    router.push(data.user?.role === 'ADMIN' ? '/admin' : '/events')
  }

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-xl font-bold mb-4">เข้าสู่ระบบ</h1>
      {error && <p className="text-red-600 mb-2">{error}</p>}
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="login-email" className="text-sm font-medium">
            อีเมล
          </label>
          <input
            id="login-email"
            name="email"
            type="email"
            placeholder="อีเมล"
            required
            className="border p-2 rounded"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="login-password" className="text-sm font-medium">
            รหัสผ่าน
          </label>
          <input
            id="login-password"
            name="password"
            type="password"
            placeholder="รหัสผ่าน"
            required
            className="border p-2 rounded"
          />
        </div>
        <button type="submit" className="bg-black text-white p-2 rounded">
          เข้าสู่ระบบ
        </button>
      </form>
    </main>
  )
}
