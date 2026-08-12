# Phase 5 — Admin panel

**สถานะ:** อนุมัติแล้ว 12 ส.ค. 2026 · ต่อจาก Phase 4 (ออกตั๋ว + อีเมล) ที่เสร็จบน branch `phase4-ticket-issuance`

## เป้าหมาย

ให้คนดูแลระบบสร้าง event/รอบ/ผังที่นั่งได้เอง ดูรายการจองทั้งหมดได้ และเห็นยอดขายต่อรอบ ปิดข้อกำหนดข้อสุดท้ายจาก 5 ข้อของโจทย์ (admin panel)

**ขอบเขตจงใจแคบ** ผู้กำหนดขอบเขตสั่งว่า "เอาแบบเรียบๆ" ทุกอย่างที่ตัดออกในหัวข้อสุดท้ายจึงเป็นการตัดโดยตั้งใจ ไม่ใช่ลืม

## การตัดสินใจของคนที่กำหนดขอบเขตนี้

ทั้งสามข้อตัดสินเมื่อ 12 ส.ค. 2026 หลังเห็นทางเลือกและผลของแต่ละทาง:

1. **ไม่มีการคืนเงิน** ไม่มี `POST /admin/bookings/:id/refund` ไม่ต่อ refund API ของ provider — `/admin/bookings` แค่แสดงสถานะ `REFUND_REQUIRED` ให้เห็น คนไปกดคืนเงินเองใน dashboard ของ provider
2. **ไม่มีปุ่มยกเลิกรอบ** ไม่มี endpoint ไหนเปลี่ยน `Showtime.status` เลย เหตุผลอยู่ในหัวข้อถัดไป
3. **ไม่มี DELETE เลยสักตัว** มีแค่ create/update — FK ทั้งสายเป็น RESTRICT อยู่แล้ว ลบ event ที่มีคนจองจะ error อยู่ดี และ `CLAUDE.md` §5 ห้ามลบข้อมูลจริงโดยไม่ถามคน การไม่มี endpoint เลยคือทางที่โค้ดน้อยที่สุดและปลอดภัยที่สุดพร้อมกัน

## ทำไมไม่มีปุ่มยกเลิกรอบ

`createBooking` เช็ค `showtimeStatus !== 'SCHEDULED'` อยู่แล้ว (`apps/api/src/lib/booking.ts:61`) แต่ query นั้นล็อกเฉพาะแถว `Seat` (`FOR UPDATE OF s`) ไม่ได้ล็อกแถว `Showtime` ที่ join เข้ามา

แปลว่าถ้ามี endpoint ที่เขียน `Showtime.status = CANCELLED` เมื่อไหร่ จะเกิด check-then-act race ทันที: คนจองอ่านเห็น `SCHEDULED` → admin กดยกเลิกและ commit → คนจองเขียน booking ลงไปในรอบที่ถูกยกเลิกไปแล้ว เป็นบั๊กตระกูลเดียวกับที่โปรเจกต์นี้เจอมาแล้วหกครั้ง

วันนี้ race นี้**เอื้อมไม่ถึง** เพราะไม่มีโค้ดตรงไหนเขียน `Showtime.status` ตอน runtime เลย การไม่เพิ่มปุ่มยกเลิกคือการทำให้มันหลับต่อไป

**ถ้าวันหน้าต้องมีปุ่มยกเลิกจริง** ต้องแก้ `createBooking` ให้ล็อกแถว `Showtime` ด้วย (เพิ่ม `FOR UPDATE OF s, t` หรือ `SELECT ... FROM "Showtime" WHERE id = ... FOR UPDATE` ก่อนล็อกที่นั่ง ตามลำดับ Showtime → Seat เพื่อไม่ให้ deadlock กับ `applyPaymentOutcome` ที่ใช้ Booking → Payment → Seat) **และต้องมี integration test ที่ยิงจอง-กับ-ยกเลิกพร้อมกันจริง** ไม่ใช่ unit test ที่ mock ไว้ — unit test มองบั๊กชนิดนี้ไม่เห็นเลยสักครั้งในโปรเจกต์นี้

## หลักการที่ยึด

**audit log อยู่ใน transaction เดียวกับการเขียนจริง** ถ้าเขียนแยกกัน จะมีเคสที่ข้อมูลถูกแก้สำเร็จแต่ log หาย (หรือกลับกัน) — log ที่เชื่อไม่ได้แย่กว่าไม่มี log เพราะมันสร้างความมั่นใจผิดๆ

**role อ่านจาก DB ไม่ใช่จาก JWT** เหตุผลอยู่ในหัวข้อ middleware

## Data model

เพิ่มตารางเดียว ไม่แก้ตารางเดิม

```prisma
model AdminAuditLog {
  id         String   @id @default(cuid())
  adminId    String
  admin      User     @relation(fields: [adminId], references: [id])
  action     String   // 'venue.create' | 'event.update' | 'seatmap.create' ...
  targetType String   // 'Venue' | 'Event' | 'Showtime' | 'SeatMap'
  targetId   String
  createdAt  DateTime @default(now())

  @@index([createdAt])
}
```

`User` เพิ่ม back-relation `auditLogs AdminAuditLog[]`

**`action` เป็น String ไม่ใช่ enum** เพราะทุกครั้งที่เพิ่ม action ใหม่ enum จะบังคับให้ migrate ตาม ซึ่งไม่ได้ให้อะไรกลับมานอกจากงาน ตั้งชื่อเป็น `<resource>.<verb>` ให้เดาได้

**ไม่เก็บ before/after ของข้อมูล** เก็บแค่ว่าใครทำอะไรกับอะไรเมื่อไหร่ ตามที่แผนงานข้อ 4.2 ระบุ ถ้าวันหน้าต้องย้อนดูว่าค่าเปลี่ยนจากอะไรเป็นอะไร ค่อยเพิ่มคอลัมน์ JSON

## Middleware: `requireAdmin`

อยู่ใน `apps/api/src/middleware/auth.ts` ไฟล์เดียวกับ `requireAuth` ใช้ต่อท้ายกันเสมอ:

```ts
router.post('/events', requireAuth, requireAdmin, createEventHandler)
```

**อ่าน `role` จากฐานข้อมูล ไม่ใช่จาก payload ของ JWT** — token มีอายุ 2 ชั่วโมง (`JWT_MAX_AGE_MS`) ถ้าถอดสิทธิ์ admin ของใครออกวันนี้ token ใบเดิมจะยังผ่านด่านไปได้อีกสองชั่วโมงเต็ม เป็นราคาที่ไม่ควรจ่ายสำหรับหน้าที่แก้ข้อมูลได้ทั้งระบบ ค่าใช้จ่ายคือหนึ่ง query ต่อ request เฉพาะเส้น `/admin` เท่านั้น

ไม่ใช่ admin → **`404`** ไม่ใช่ `403` ตามกติกา status code ในแผนงานข้อ 5.1 (`403` ยืนยันว่าเส้นทางนั้นมีอยู่จริง)

## Endpoints

ทุกตัวผ่าน `requireAuth` + `requireAdmin`

| Method | Path | ทำอะไร |
|---|---|---|
| `GET` | `/admin/venues` | รายการสถานที่ |
| `POST` | `/admin/venues` | สร้างสถานที่ |
| `PATCH` | `/admin/venues/:id` | แก้ชื่อ/ที่อยู่ |
| `GET` | `/admin/events` | รายการ event **ทั้งหมด** ต่างจาก `GET /events` สาธารณะที่กรองไว้ |
| `POST` | `/admin/events` | สร้าง event ผูกกับ venue |
| `PATCH` | `/admin/events/:id` | แก้ชื่อ/คำอธิบาย/venue |
| `POST` | `/admin/showtimes` | สร้างรอบ |
| `PATCH` | `/admin/showtimes/:id` | แก้เวลาเริ่ม/จบ |
| `POST` | `/admin/seatmaps` | สร้างโซน + ราคา + **generate ที่นั่งทั้งโซนในครั้งเดียว** |
| `GET` | `/admin/bookings` | รายการจอง filter `?status=` `?email=` |
| `GET` | `/admin/dashboard` | ยอดขาย + ที่นั่งคงเหลือต่อรอบ |

### `POST /admin/seatmaps` สร้างที่นั่งให้ด้วย

รับ `{ showtimeId, zoneName, price, rows: string[], seatsPerRow: number }` แล้วสร้าง `SeatMap` หนึ่งแถวกับ `Seat` จำนวน `rows.length × seatsPerRow` **ในทรานแซกชันเดียว**

ยิงทีละที่นั่งจาก UI สำหรับโซน 200 ที่นั่งคือ 200 request ที่พังกลางคันได้ และจะทิ้งโซนที่มีที่นั่งไม่ครบไว้

- `price` เป็น `Int` (บาทเต็มจำนวน) เหมือน `totalPrice` ที่อื่นทั้งระบบ ห้าม Float
- ที่นั่งที่สร้างมี `status` เป็น `AVAILABLE` เสมอ ไม่รับค่าจาก client
- `@@unique([seatMapId, row, number])` เดิมกันที่นั่งซ้ำในโซนอยู่แล้ว
- จำกัด `rows.length × seatsPerRow` ไว้ที่ค่าคงที่ใน `lib/config.ts` (`MAX_SEATS_PER_SEATMAP = 100`) เกินกว่านั้นตอบ `400` — ตัวเลขนี้คนกำหนดเมื่อ 12 ส.ค. 2026 ว่าพอสำหรับงานนี้ ไม่ใช่ค่าที่คำนวณมาจากขนาดฮอลล์จริง โซนที่ใหญ่กว่านี้ต้องยิงหลาย request หรือมาขยับตัวเลขนี้ที่เดียว

### `GET /admin/bookings`

filter ด้วย `status` (ค่าใดค่าหนึ่งใน `BookingStatus`) และ `email` (ค้นแบบ contains) ทั้งคู่ optional เรียงใหม่→เก่า

**`REFUND_REQUIRED` โผล่ที่นี่** นี่คือทั้งหมดที่ Phase 5 ทำกับหนี้ก้อนนั้นตามที่ตกลงไว้ — คนเห็นแล้วไปกดคืนเงินเองใน dashboard ของ provider

**LIMITATION: ไม่มี pagination** `take: 100` ตายตัว พอสำหรับข้อมูลระดับนี้ ถ้าวันไหนเกินร้อยรายการแล้วต้องดูของเก่า ต้องเพิ่ม cursor pagination

### `GET /admin/dashboard`

ต่อหนึ่งรอบ: ชื่อ event, เวลาเริ่ม, ที่นั่งทั้งหมด, ที่นั่งที่ไม่ว่าง, ยอดเงินรวมจาก booking ที่ `PAID` เท่านั้น

**สองตัวเลขนี้นับคนละฐานโดยตั้งใจ ห้ามเอามาเทียบกัน**

- **ที่นั่งไม่ว่าง** นับจาก `Seat.status = BOOKED` ซึ่ง `createBooking` ตั้งตั้งแต่ตอน hold ไม่ใช่ตอนจ่ายเงิน แปลว่าเลขนี้**รวมที่นั่งที่ยังไม่จ่ายเงินและอาจหมดเวลาใน 5 นาที** ซึ่งถูกต้องแล้วสำหรับคำถาม "ตอนนี้เหลือที่ให้ขายกี่ที่"
- **ยอดเงิน** นับเฉพาะ booking ที่ `PAID` — `PENDING_PAYMENT` ยังไม่ใช่เงิน และ `REFUND_REQUIRED` เป็นเงินที่ติดค้างต้องคืน การรวมสองอย่างนี้เข้าไปจะทำให้ยอดขายโกหก

ผลคือ "ที่นั่งไม่ว่าง × ราคา" จะไม่เท่ากับยอดเงินเสมอไป และไม่ควรเท่า หน้าเว็บต้องตั้งชื่อคอลัมน์ให้ชัดว่าอันไหนคืออะไร ไม่ใช่ปล่อยให้คนอ่านเดาแล้วสรุปว่าตัวเลขผิด

## หน้าเว็บ (4 หน้า)

| Path | หน้าอะไร |
|---|---|
| `/admin` | dashboard ยอดขาย/ที่นั่งคงเหลือต่อรอบ |
| `/admin/events` | รายการ + ฟอร์มสร้าง/แก้ event และ venue |
| `/admin/events/[id]/showtimes` | รอบของ event นั้น + ฟอร์มสร้างรอบและผังที่นั่ง |
| `/admin/bookings` | รายการจอง + filter สถานะ/อีเมล |

ตัด `/admin/bookings/[id]` ออกจากแผนเดิม เพราะไม่มีปุ่ม refund แล้ว รายละเอียดที่เหลือใส่ในตารางได้หมด — หน้าที่มีแต่ข้อมูลอ่านอย่างเดียวและไม่มีปุ่มอะไรเลยไม่คุ้มค่าที่จะมี

ภาษาไทยทั้งหมด · วันที่ `toLocaleString('th-TH')` · ทุก input มี `<label>` ผูก `htmlFor` · ไม่มี business logic ฝั่ง frontend

**การ guard ฝั่งหน้าเว็บเป็นแค่ UX** ถ้า API ตอบ 404 ให้เด้งออก ตัวกันจริงอยู่ที่ `requireAdmin` ฝั่ง server เท่านั้น ห้ามเชื่อ role ที่ frontend ถืออยู่

## seed

`prisma/seed.ts` เพิ่ม admin หนึ่งคน อีเมลและรหัสผ่านอ่านจาก env (`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`) ไม่ commit ค่าจริง

seed มี guard กันรันนอก localhost อยู่แล้ว (`assertSeedIsSafe`) จึงไม่ต้องเพิ่ม guard ใหม่ — แต่ถ้าไม่ได้ตั้ง env ทั้งสองตัว ให้ **ข้ามการสร้าง admin ไปเงียบๆ ไม่ใช่ตั้งรหัสผ่าน default** รหัสผ่าน default ของบัญชี admin คือประตูหลังที่ commit ลง git

## Test ที่ต้องมี

1. user ธรรมดายิง `/admin/*` ได้ `404` และไม่มีอะไรถูกเขียนลง DB
2. **ผู้ใช้ที่เพิ่งถูกถอด role ADMIN เข้าไม่ได้ทันที ทั้งที่ token ใบเดิมยังไม่หมดอายุ** — เคสที่พิสูจน์ว่า role อ่านจาก DB จริง ไม่ใช่จาก JWT
3. ทุก mutation สร้างแถว `AdminAuditLog` พร้อม adminId ที่ถูกต้อง
4. **mutation ที่ fail ต้องไม่ทิ้ง audit log ค้าง** — พิสูจน์ว่าอยู่ใน transaction เดียวกันจริง
5. `POST /admin/seatmaps` สร้างที่นั่งครบ `rows × seatsPerRow` และเกิน `MAX_SEATS_PER_SEATMAP` ต้องถูกปฏิเสธ
6. `POST /admin/seatmaps` ที่ fail กลางคันต้องไม่ทิ้ง SeatMap ที่มีที่นั่งไม่ครบ
7. `/admin/bookings` filter ด้วย status และ email แล้วได้ผลถูก
8. `/admin/dashboard` นับที่นั่งและยอดเงินถูก และ**ไม่นับ booking ที่ยังไม่ `PAID` เข้ายอดขาย**

## สิ่งที่ตัดออกโดยตั้งใจ

| ตัดอะไร | เพิ่มเมื่อไหร่ |
|---|---|
| คืนเงิน (endpoint + provider API) | ตัดถาวรตามการตัดสินใจ 12 ส.ค. 2026 |
| ยกเลิกรอบ | ต้องแก้ `createBooking` ให้ล็อกแถว Showtime ก่อน พร้อม integration test — ดูหัวข้อข้างบน |
| `DELETE` ทุกตัว | มีเคสจริงที่ต้องลบ และคนอนุมัติแล้ว |
| กราฟ/chart ใน dashboard | ตัวเลขในตารางอ่านไม่พอ |
| export CSV | มีคนขอ |
| pagination | รายการเกิน 100 จริง |
| แก้ราคาโซนที่ขายไปแล้ว | มีคนขอ — และต้องคิดก่อนว่า booking เก่าที่จ่ายราคาเดิมไปแล้วจะเป็นยังไง |

## Checklist ตรวจรับ (จากแผนงานข้อ 6)

- [ ] หน้า admin ทุกหน้าถูก guard ด้วย role check จริง — ทดสอบเข้าด้วย user ทั่วไปต้องโดนเด้ง (test 1 + กดเองผ่านหน้าเว็บจริง)
- [ ] ทุก action ที่แก้ข้อมูลมี record ใน `AdminAuditLog` (test 3 + 4)
- [ ] ~~คืนเงินแล้ว seat กลับมาว่างถูกต้อง~~ — **ปิดไม่ได้ เพราะตัดการคืนเงินออกตามการตัดสินใจของคน** ต้องรายงานตรงๆ ว่าตัดออก ไม่ใช่ว่าผ่าน
- [ ] `npm run build` + `npm test` ผ่านทั้งสอง app
