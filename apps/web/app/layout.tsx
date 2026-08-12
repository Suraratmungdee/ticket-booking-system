import type { Metadata } from 'next'
import './globals.css'
import Header from './header'

export const metadata: Metadata = {
  title: 'Ticket Booking',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body className="min-h-screen bg-white text-gray-900">
        <Header />
        {children}
      </body>
    </html>
  )
}
