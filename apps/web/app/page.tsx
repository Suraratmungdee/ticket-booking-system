import Link from 'next/link'

export default function HomePage() {
  return (
    <main className="mx-auto max-w-xl p-8 flex flex-col gap-4">
      <h1 className="text-2xl font-bold">ระบบจองตั๋ว</h1>
      {/* Sign-in and sign-up moved to the header, which hides them once a
          session exists. Duplicating them here would show them to someone
          already signed in. */}
      <nav className="flex gap-4">
        <Link className="underline" href="/events">
          ดูรายการ Event
        </Link>
      </nav>
    </main>
  )
}
