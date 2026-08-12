'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiFetch } from '@/lib/api'

type User = { id: string; email: string; name: string; role: string }

export default function Header() {
  const router = useRouter()
  const pathname = usePathname()
  // undefined = still asking, null = signed out, User = signed in. The three
  // states are distinct on purpose: rendering the signed-out links during the
  // first fetch would flash "เข้าสู่ระบบ" at someone who is already signed in.
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const isAdmin = user?.role === 'ADMIN'
  // One "home" per role: an admin's is the dashboard, everyone else's is the
  // landing page. This is what the back button keys off — see below.
  const homePath = isAdmin ? '/admin' : '/'

  // Keyed on pathname, not [] — this component sits in the root layout and
  // never unmounts, so a mount-only fetch would keep showing "เข้าสู่ระบบ"
  // after a client-side login until a full page reload. The cost is one
  // /auth/me per navigation, which is fine at this size.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await apiFetch('/auth/me')
        const next = res.ok ? ((await res.json()).user as User) : null
        if (!cancelled) setUser(next)
      } catch {
        // An unreachable API reads as signed out here. The header is not the
        // right place for an error banner — whichever page the user is on
        // reports its own failure.
        if (!cancelled) setUser(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pathname])

  async function handleLogout() {
    try {
      await apiFetch('/auth/logout', { method: 'POST' })
    } catch {
      // Swallowed deliberately: fall through to clearing local state and
      // redirecting, so a failed request can never strand someone on a page
      // they are no longer allowed to load.
    }
    setUser(null)
    router.push('/')
  }

  return (
    <header className="border-b">
      <nav className="mx-auto max-w-4xl p-4 flex flex-wrap items-center gap-4 text-sm">
        {/* Shown everywhere except the role's own home page, where there is
            nothing to go back to and router.back() would walk out of the site
            entirely. For an admin that means /admin/events and
            /admin/bookings get it, while /admin itself does not. */}
        {user !== undefined && pathname !== homePath && (
          <button type="button" onClick={() => router.back()} className="underline">
            ‹ ย้อนกลับ
          </button>
        )}

        {/* Hidden from admins: the landing page and catalogue are customer
            surfaces. Everything here waits for the session to resolve, so an
            admin never watches links appear and then vanish. */}
        {user !== undefined && !isAdmin && (
          <>
            <Link href="/" className="font-bold">
              ระบบจองตั๋ว
            </Link>
            <Link href="/events" className="underline">
              ดูรายการ Event
            </Link>
          </>
        )}
        {user && !isAdmin && (
          <Link href="/me/tickets" className="underline">
            ตั๋วของฉัน
          </Link>
        )}
        {isAdmin && (
          <Link href="/admin" className="underline">
            แอดมิน
          </Link>
        )}

        {user && (
          <>
            <span className="ml-auto text-gray-600">
              {user.email}
              {isAdmin && ' (แอดมิน)'}
            </span>
            <button type="button" onClick={handleLogout} className="underline">
              ออกจากระบบ
            </button>
          </>
        )}
        {user === null && (
          <>
            <Link href="/login" className="underline ml-auto">
              เข้าสู่ระบบ
            </Link>
            <Link href="/register" className="underline">
              สมัครสมาชิก
            </Link>
          </>
        )}
      </nav>
    </header>
  )
}
