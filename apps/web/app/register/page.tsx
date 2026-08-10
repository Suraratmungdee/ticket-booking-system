'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api'

export default function RegisterPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const form = new FormData(e.currentTarget)

    let res: Response
    try {
      res = await apiFetch('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          email: form.get('email'),
          password: form.get('password'),
          name: form.get('name'),
        }),
      })
    } catch (err) {
      console.error(err)
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง')
      return
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(typeof data.error === 'string' ? data.error : 'สมัครสมาชิกไม่สำเร็จ')
      return
    }

    router.push('/login')
  }

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-xl font-bold mb-4">สมัครสมาชิก</h1>
      {error && <p className="text-red-600 mb-2">{error}</p>}
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input name="name" placeholder="ชื่อ" required className="border p-2 rounded" />
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
          placeholder="รหัสผ่าน (8 ตัวขึ้นไป)"
          required
          minLength={8}
          className="border p-2 rounded"
        />
        <button type="submit" className="bg-black text-white p-2 rounded">
          สมัครสมาชิก
        </button>
      </form>
    </main>
  )
}
