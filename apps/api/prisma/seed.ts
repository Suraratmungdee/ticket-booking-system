import { prisma } from '../src/lib/prisma.js'

// Two venues, three events, one showtime each — enough to exercise the
// /events date and venue filters by hand. Idempotent: clears first.
async function main() {
  await prisma.bookingSeat.deleteMany()
  await prisma.booking.deleteMany()
  await prisma.seat.deleteMany()
  await prisma.seatMap.deleteMany()
  await prisma.showtime.deleteMany()
  await prisma.event.deleteMany()
  await prisma.venue.deleteMany()

  const impact = await prisma.venue.create({
    data: { name: 'อิมแพ็ค อารีน่า เมืองทองธานี', address: 'ปากเกร็ด นนทบุรี' },
  })
  const paragon = await prisma.venue.create({
    data: { name: 'พารากอน ซีนีเพล็กซ์', address: 'ปทุมวัน กรุงเทพฯ' },
  })

  await prisma.event.create({
    data: {
      title: 'คอนเสิร์ตใหญ่ประจำปี',
      description: 'คอนเสิร์ตเต็มรูปแบบ 3 ชั่วโมง พร้อมวงออร์เคสตรา',
      venueId: impact.id,
      showtimes: {
        create: [
          { startTime: new Date('2026-09-12T12:00:00Z'), endTime: new Date('2026-09-12T15:00:00Z') },
          { startTime: new Date('2026-09-13T12:00:00Z'), endTime: new Date('2026-09-13T15:00:00Z') },
        ],
      },
    },
  })

  await prisma.event.create({
    data: {
      title: 'เทศกาลดนตรีกลางแจ้ง',
      description: 'ศิลปิน 12 วง 2 เวที ตั้งแต่บ่ายจนดึก',
      venueId: impact.id,
      showtimes: {
        create: [
          { startTime: new Date('2026-09-12T07:00:00Z'), endTime: new Date('2026-09-12T16:00:00Z') },
        ],
      },
    },
  })

  await prisma.event.create({
    data: {
      title: 'รอบปฐมทัศน์ภาพยนตร์',
      description: 'รอบสื่อมวลชนและแขกรับเชิญ',
      venueId: paragon.id,
      showtimes: {
        create: [
          { startTime: new Date('2026-09-20T13:00:00Z'), endTime: new Date('2026-09-20T15:00:00Z') },
          { startTime: new Date('2026-09-20T16:00:00Z'), endTime: new Date('2026-09-20T18:00:00Z'), status: 'CANCELLED' },
        ],
      },
    },
  })

  const venues = await prisma.venue.findMany({ select: { id: true, name: true } })
  console.log('Seeded. Venue ids for filter testing:')
  for (const v of venues) console.log(`  ${v.id}  ${v.name}`)

  const ZONES = [
    { zoneName: 'VIP', price: 3500 },
    { zoneName: 'ธรรมดา', price: 2000 },
    { zoneName: 'ยืน', price: 1200 },
  ]
  const ROWS = ['A', 'B', 'C', 'D', 'E']
  const SEATS_PER_ROW = 6

  const showtimes = await prisma.showtime.findMany({ select: { id: true } })
  for (const showtime of showtimes) {
    for (const zone of ZONES) {
      await prisma.seatMap.create({
        data: {
          showtimeId: showtime.id,
          zoneName: zone.zoneName,
          price: zone.price,
          seats: {
            create: ROWS.flatMap((row) =>
              Array.from({ length: SEATS_PER_ROW }, (_, i) => ({ row, number: i + 1 })),
            ),
          },
        },
      })
    }
  }
  console.log(`Seeded ${showtimes.length} showtimes x ${ZONES.length} zones x ${ROWS.length * SEATS_PER_ROW} seats`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
