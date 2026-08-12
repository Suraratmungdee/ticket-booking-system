# 5. Database Schema

> **ปรับปรุงล่าสุด 13 ส.ค. 2569 ให้ตรงกับ `apps/api/prisma/schema.prisma` จริงหลัง Phase 6** — เวอร์ชันนี้แทนที่ draft ตอน Phase 0 ทั้งหมด อย่าอ้างอิงเวอร์ชันเก่าอีก ต้นฉบับที่เป็นความจริงเสมอคือไฟล์ `.prisma` ไม่ใช่เอกสารนี้

ตารางหลัก (ย่อ type, ดู field ครบ + comment อธิบายเหตุผลแต่ละจุดใน `schema.prisma` ตัวจริง):

```
User          (id, email, passwordHash, name, role[USER|ADMIN], createdAt)
Venue         (id, name, address)
Event         (id, title, description, venueId -> Venue)
Showtime      (id, eventId -> Event, startTime, endTime, status[SCHEDULED|CANCELLED])
SeatMap       (id, showtimeId -> Showtime, zoneName, price)              -- unique(showtimeId, zoneName)
Seat          (id, seatMapId -> SeatMap, row, number, status[AVAILABLE|BOOKED])   -- unique(seatMapId, row, number)
Booking       (id, userId -> User, showtimeId -> Showtime,
               status[PENDING_PAYMENT|PAID|EXPIRED|CANCELLED|REFUND_REQUIRED],
               totalPrice, createdAt, expiresAt)                         -- index(status, expiresAt)
BookingSeat   (id, bookingId -> Booking, seatId -> Seat)                 -- join table, unique(bookingId, seatId)
Payment       (id, bookingId -> Booking [unique], provider, providerRef [unique], amount, status[PENDING|SUCCEEDED|FAILED], paidAt, createdAt)
WebhookEvent  (id, eventId [unique], receivedAt)                         -- idempotency ledger, ไม่ผูกกับตารางไหน
Ticket        (id, bookingId -> Booking [unique], qrCodePayload, issuedAt)
AdminAuditLog (id, adminId -> User, action, targetType, targetId, createdAt)  -- index(createdAt)
```

ความสัมพันธ์สำคัญ:
- `Event 1—N Showtime`, `Showtime 1—N SeatMap 1—N Seat`
- `Booking N—N Seat` ผ่าน `BookingSeat` (1 booking จองได้หลายที่นั่ง)
- `Booking 1—1 Payment`, `Booking 1—1 Ticket` — ทั้งคู่ `@unique` บน `bookingId` ไม่ใช่แค่ตั้งใจ MVP แต่เป็นตัวกันชนตัวจริง: webhook ที่มาซ้ำ (retry/at-least-once delivery) ต้องแพ้ constraint แทนที่จะสร้างซ้ำ (ดู comment ใน schema ที่ `Ticket`/`WebhookEvent`)
- `Seat.status` ต้อง sync กับ `Booking.status` เสมอผ่าน transaction เดียว ห้ามอัพเดตแยกกันคนละ query
- `AdminAuditLog` ต้องเขียนใน transaction เดียวกับ action ที่มันบันทึก — log ที่ไม่ตรงกับข้อมูลจริงอันตรายกว่าไม่มี log

**ต่างจาก draft เดิมตรงไหนบ้าง (และทำไม):**
- **`Seat.status` ตัด `HELD` ออก** เหลือ `AVAILABLE | BOOKED` — hold เป็นสถานะชั่วคราวอายุ 5 นาที อยู่ใน Redis แหล่งเดียว เก็บซ้ำใน DB จะสร้างแหล่งความจริง 2 ที่ที่ต้อง sync กันตลอดเวลา และเมื่อ process ตายกลางทางจะเหลือแถว `HELD` ค้างตลอดกาลโดยไม่มี TTL มาเก็บกวาด (รายละเอียด: `docs/superpowers/specs/2026-08-10-phase2-seats-booking-design.md`)
- **`Booking.status` เพิ่ม `REFUND_REQUIRED`** — เพิ่มตอน Phase 5 (admin refund) เป็นสถานะกลางระหว่าง "แอดมินกดคืนเงินแล้ว" กับ "เงินคืนจริงเสร็จ" (payment provider จริงเป็น async)
- **เพิ่มตาราง `WebhookEvent`** — ป้องกัน Stripe/mock provider ยิง webhook ซ้ำแล้วออกตั๋วซ้ำ (Phase 3 checklist ข้อ "duplicate event ไม่สร้าง ticket ซ้ำ")
- **เพิ่มตาราง `AdminAuditLog`** จริงตาม draft เดิม แต่ตอนนี้มี `@@index([createdAt])` และ `action` เป็น `String` อิสระ (ไม่ใช่ enum) ตั้งใจ — enum จะบังคับ migration ทุกครั้งที่เพิ่ม action ใหม่โดยไม่ได้อะไรกลับมา

---

## 5.1 API Endpoints

REST ทั้งหมดอยู่ที่ `apps/api` — `apps/web` ไม่มี route handler ของตัวเอง ทุก endpoint ที่แตะเงิน/ที่นั่ง/สถานะจอง validate input และเช็ค state ก่อนเขียน DB เสมอ

| Phase | Method | Path | Auth | ทำอะไร |
|---|---|---|---|---|
| 1 | `POST` | `/auth/register` | – | สมัครสมาชิก hash รหัสด้วย bcrypt |
| 1 | `POST` | `/auth/login` | – | ล็อกอิน ออก JWT เป็น httpOnly cookie |
| 1 | `GET` | `/events` | – | รายการ event กรองด้วย `?date=` `?venueId=` |
| 1 | `GET` | `/events/:id` | – | รายละเอียด event + รอบทั้งหมด |
| 2 | `GET` | `/showtimes/:id/seats` | – | ผังที่นั่งพร้อมสถานะ (รวม HELD จาก Redis) |
| 2 | `POST` | `/showtimes/:id/seats/hold` | ✅ | ล็อกที่นั่ง + สร้าง Booking(`PENDING_PAYMENT`) |
| 2 | `GET` | `/bookings/:id` | ✅ เจ้าของ | สถานะ booking + เวลาที่เหลือ |
| 3 | `POST` | `/bookings/:id/checkout` | ✅ เจ้าของ | สร้าง Stripe Checkout Session |
| 3 | `POST` | `/webhooks/stripe` | signature | รับ `checkout.session.completed` → `PAID` |
| 4 | `GET` | `/me/tickets` | ✅ | ตั๋วทั้งหมดของผู้ใช้ |
| 4 | `GET` | `/tickets/:id` | ✅ เจ้าของ | ตั๋วใบเดียว + QR payload |
| 5 | `GET/POST/PATCH/DELETE` | `/admin/events`, `/admin/showtimes`, `/admin/seatmaps` | ✅ ADMIN | CRUD |
| 5 | `GET` | `/admin/bookings` | ✅ ADMIN | รายการ booking + filter สถานะ/อีเมล |
| 5 | `POST` | `/admin/bookings/:id/refund` | ✅ ADMIN | คืนเงิน + บันทึก AdminAuditLog |
| 5 | `GET` | `/admin/dashboard` | ✅ ADMIN | สรุปยอดขาย/ที่นั่งคงเหลือต่อรอบ |
| – | `GET` | `/health` | – | health check |

กติกา status code ที่ใช้ตรงกันทุก endpoint: `400` input ไม่ผ่าน validate · `401` ไม่ได้ล็อกอิน · `404` ไม่พบ **หรือไม่ใช่เจ้าของ** (ไม่ใช้ `403` เพื่อไม่ให้เดาได้ว่า id ไหนมีอยู่จริง) · `409` ที่นั่ง/อีเมลชนกัน · `429` ยิงถี่เกิน · `500` ข้อผิดพลาดฝั่งเซิร์ฟเวอร์ (ไม่เปิดเผยรายละเอียดภายใน)

> รายชื่อ endpoint ปัจจุบันจริง (หลัง Phase 6, รวม `/auth/me`, `/auth/logout`, `/mock-provider/...`) อยู่ใน [`../../README.md`](../../README.md) หัวข้อ "API ที่มีตอนนี้" — ตารางด้านบนคือ draft ตอนวางแผน ไม่ได้อัปเดตตามทุก endpoint ที่เพิ่มภายหลัง

---

## 5.2 รายการหน้าจอ

**ฝั่งผู้ใช้** (`apps/web`)

| Phase | Path | หน้าอะไร |
|---|---|---|
| 1 | `/` | หน้าแรก |
| 1 | `/register`, `/login` | สมัครสมาชิก / เข้าสู่ระบบ |
| 1 | `/events` | รายการ event + filter วันที่/สถานที่ |
| 1 | `/events/[id]` | รายละเอียด event + เลือกรอบ |
| 2 | `/showtimes/[id]/seats` | ผังที่นั่ง เลือกที่นั่ง กดจอง |
| 2 | `/bookings/[id]` | สถานะการจอง + นับถอยหลัง 5 นาที |
| 3 | `/bookings/[id]/payment` | ส่งต่อไป Stripe Checkout |
| 3 | `/bookings/[id]/success`, `/cancel` | ผลการชำระเงิน |
| 4 | `/me/tickets` | ตั๋วของฉัน |
| 4 | `/me/tickets/[id]` | ตั๋วใบเดียว + QR |

**ฝั่ง Admin** (Phase 5, ทุกหน้า guard ด้วย role check)

| Path | หน้าอะไร |
|---|---|
| `/admin` | Dashboard สรุปยอดขาย/ที่นั่งคงเหลือ |
| `/admin/events` | CRUD event + venue |
| `/admin/events/[id]/showtimes` | CRUD รอบ + ผังที่นั่ง/ราคาต่อโซน |
| `/admin/bookings` | รายการ booking + filter + ค้นหา |
| `/admin/bookings/[id]` | รายละเอียด + ปุ่มยกเลิก/คืนเงิน |

รวม 12 หน้าฝั่งผู้ใช้ + 5 หน้าฝั่ง admin

---

## 5.3 บริการภายนอกที่เลือกใช้

| ใช้ทำอะไร | เลือก | เหตุผล |
|---|---|---|
| ชำระเงิน | **Stripe** (test mode) | เอกสารดี มี CLI จำลอง webhook ได้ ไม่ต้องจ่ายเงินจริงตอนพัฒนา |
| ส่งอีเมล (Phase 4) | **Resend** | SDK เรียบง่ายกว่า SendGrid/SES มาก (ส่งเมลได้ในไม่กี่บรรทัด) มี free tier พอสำหรับ staging และไม่ต้องตั้งค่า domain verification ให้ยุ่งยากตอนทดสอบ — เดิมแผนเขียนแค่ "ส่งอีเมลยืนยัน" โดยไม่ระบุผู้ให้บริการ ซึ่งเป็นช่องที่ agent จะเดาเอง |
| ฐานข้อมูล (dev) | **Postgres ใน Docker** | `docker compose up` ครั้งเดียวจบ ไม่ต้องสมัครบริการ ไม่มีปัญหา free tier หมดอายุ |
| Redis (dev) | **Redis ใน Docker** | เหตุผลเดียวกัน โค้ดอ่านจาก `REDIS_URL` เลยย้ายไป Upstash ตอน deploy ได้โดยไม่แก้โค้ด |

> **หมายเหตุ 13 ส.ค. 2569:** ท้ายที่สุดไม่ได้ integrate Stripe จริง — ใช้ mock provider แทนตลอดทั้งโปรเจกต์ (โครงสร้าง checkout/webhook/idempotency เป็นของจริงครบ แค่สลับตัวผู้ให้บริการ) ดูเหตุผลใน `docs/superpowers/specs/2026-08-11-phase3-payment-design.md`

---

## 5.4 ข้อกำหนดที่ไม่ใช่ฟังก์ชัน (Non-functional)

| เรื่อง | ข้อกำหนด |
|---|---|
| ภาษา | UI เป็นภาษาไทยทั้งหมด ยังไม่ทำ i18n (ผู้ใช้เป้าหมายเป็นคนไทย) วันที่แสดงด้วย `toLocaleString('th-TH')` เป็น พ.ศ. |
| Responsive | ต้องใช้งานบนมือถือได้ เพราะคนจองตั๋วส่วนใหญ่มาจากมือถือ — ผังที่นั่งต้องกดเลือกด้วยนิ้วได้ (ปุ่มไม่เล็กกว่า 44×44px) |
| Accessibility | ทุก input มี `<label>` ผูกด้วย `htmlFor` · ที่นั่งต้องไม่สื่อสถานะด้วยสีอย่างเดียว (ต้องมีข้อความ/สัญลักษณ์กำกับ เพราะคนตาบอดสีแยกไม่ออก) · นำทางด้วยคีย์บอร์ดได้ |
| ความเร็ว | หน้าผังที่นั่งต้องแสดงผลภายใน ~1 วินาที (อ่าน Redis ทีเดียวทั้งรอบด้วย `MGET` ไม่ยิงทีละที่) |
| ความปลอดภัย | รหัสผ่าน hash ด้วย bcrypt · JWT ใน httpOnly cookie เท่านั้น (JS อ่านไม่ได้) · CORS จำกัด origin เดียว · rate limit ที่ login · ไม่มี secret ใน git |
| ความถูกต้องของข้อมูล | ราคาคำนวณจาก DB เสมอ ห้ามเชื่อ client · ทุกการเปลี่ยนสถานะที่นั่ง/booking อยู่ในทรานแซกชันเดียว |
| การกู้คืน | migration ต้อง reversible เท่าที่ทำได้ · deploy ครั้งแรกต้องเป็นคนกด |

## See also

- [`../../apps/api/prisma/schema.prisma`](../../apps/api/prisma/schema.prisma) — ต้นฉบับที่เป็นความจริงเสมอ
- [`04-flow-design.md`](04-flow-design.md) · [`06-phase-plan.md`](06-phase-plan.md)
- [`../../Ticket-Booking-System-Plan.md`](../../Ticket-Booking-System-Plan.md) — สารบัญเอกสารทั้งหมด
