import Link from 'next/link'

export default function HomePage() {
  return (
    <main className="mx-auto max-w-xl p-8 flex flex-col gap-4">
      <h1 className="text-2xl font-bold">ระบบจองตั๋ว</h1>
      <nav className="flex gap-4">
        <Link className="underline" href="/events">
          ดูรายการ Event
        </Link>
        <Link className="underline" href="/login">
          เข้าสู่ระบบ
        </Link>
        <Link className="underline" href="/register">
          สมัครสมาชิก
        </Link>
      </nav>
    </main>
  )
}
