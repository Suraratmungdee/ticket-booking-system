# แผนออกแบบระบบจองตั๋ว (Ticket Booking System) ด้วย AI Coding Agent

Agent ที่เลือกใช้: **Claude Code** | Stack: Next.js 16 (frontend) + Node.js/Express (backend API แยก service) + TypeScript + PostgreSQL (Prisma) + Redis + Stripe — เหตุผลอยู่ใน `CLAUDE.md` หัวข้อ 2

ไฟล์ที่ส่งมอบคู่กับเอกสารนี้:
- `CLAUDE.md` — context/instruction file เต็มรูปแบบ (ข้อ 1)
- `commands-new-endpoint.md` — custom slash command ของ Claude Code (ข้อ 2, วางที่ `.claude/commands/new-endpoint.md` ในโปรเจกต์จริง)

---

## 3. Plugin / MCP / Tool เสริม

> **ปรับปรุง 13 ส.ค. 2569:** เช็คแล้ว `.claude/settings.json` และไม่มี `.mcp.json` ในโปรเจกต์ — **ไม่มี MCP server ตัวไหนถูกติดตั้งจริงตลอด 6 phase ที่ผ่านมา** งานทั้งหมดทำด้วย Claude Code's built-in tools (Bash/Read/Edit) ล้วนๆ บวก CLI ที่เป็น dependency ของโปรเจกต์อยู่แล้ว ไม่มีอะไรเพิ่มเติมนอกเหนือจากนี้

| เครื่องมือ | ใช้ทำอะไรจริง |
|---|---|
| `npx prisma` (migrate/generate) | สร้างและรัน migration ทุกตัวใน `apps/api/prisma/migrations/` |
| `npx vitest` | รัน unit test (186 เคส) และ integration test (10 เคส) |
| `curl` | ยิง API ตรงเพื่อยืนยันพฤติกรรมจริง (login/CORS/preflight) แทนการเดาจากโค้ดอย่างเดียว — ใช้ตอนไล่บั๊ก `/admin` |
| `docker compose` | รัน Postgres + Redis dev ตาม `docker-compose.yml` |

---

## 4. Flow Design

### 4.1 ฝั่งผู้ใช้ (happy path)

1. ค้นหา event/รอบ (by วันที่, สถานที่, ประเภท) → เห็นรายการ showtime ที่ว่าง
2. เลือก showtime → เห็นผังที่นั่ง (ที่นั่งว่าง/ถูกจอง/ถูก hold ชั่วคราว)
3. เลือกที่นั่ง → ระบบสร้าง **seat hold** (Redis key, TTL 5 นาที) กันคนอื่นจองซ้ำ
4. สร้าง booking สถานะ `PENDING_PAYMENT` → ไปหน้าชำระเงิน
5. ชำระเงินผ่าน Stripe Checkout
6. Stripe ยิง webhook `checkout.session.completed` → server verify signature → อัพเดต booking เป็น `PAID` → ปลด seat hold เป็น `BOOKED` ถาวร → generate ตั๋ว (QR code ผูกกับ booking id)
7. ผู้ใช้เห็น/ดาวน์โหลดตั๋วในหน้า "ตั๋วของฉัน" + ส่งอีเมลยืนยัน
8. ถ้า hold หมดเวลาก่อนจ่ายเงิน → seat กลับเป็นว่าง, booking เป็น `EXPIRED`

### 4.2 ฝั่ง Admin

- CRUD: event, venue, showtime, ผังที่นั่ง/ราคาต่อโซน
- ดูรายการ booking ทั้งหมด + filter สถานะ, ค้นหาด้วยอีเมล/booking id
- ยกเลิก/คืนเงิน booking (ต้องมี audit log ว่าใครกดตอนไหน)
- Dashboard สรุปยอดขาย/ที่นั่งคงเหลือต่อรอบ

### 4.3 Sequence สั้นๆ (ตัวหนังสือแทน diagram)

```
User -> Frontend(Next.js): เลือกที่นั่ง
Frontend -> API(Express): POST /seats/hold
API -> Redis: SET hold:seat:{id} TTL 5m
API -> DB: create Booking(PENDING_PAYMENT)
API -> Stripe: create Checkout Session
Frontend -> Stripe: redirect ไปจ่ายเงิน
Stripe -> API(webhook): checkout.session.completed
API: verify signature -> update Booking(PAID) -> Seat(BOOKED) -> generate QR
API -> User: email + Frontend ดึงสถานะตั๋วผ่าน GET /bookings/{id}
```

หมายเหตุ: frontend ไม่คุยกับ Stripe/Redis/DB โดยตรงเลย ทุกอย่างผ่าน backend API เท่านั้น

---

## 5. Database Schema

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

---

## 6. แผนการทำงานแบ่ง Phase

### Phase 0 — Setup (0.5-1 วัน)
งาน: ตั้ง npm workspaces monorepo (`apps/web` = Next.js 16, `apps/api` = Express), Prisma อยู่ใน `apps/api`, ตั้ง CORS ให้ API รับ origin เฉพาะ `apps/web` เท่านั้น, ตั้ง CI (build+test ทั้งสอง app), เขียน `CLAUDE.md` ลงโปรเจกต์จริง
Checklist ตรวจรับ:
- [ ] `npm run build` ผ่านทั้ง 2 app บนเครื่อง fresh clone
- [ ] frontend ยิง request ไป backend ข้าม origin ได้จริง (CORS ไม่บล็อก) แต่ origin อื่นถูกบล็อก
- [ ] มี `.env.example` ครบทั้ง 2 app ไม่มี secret จริงหลุดในโค้ด
- [ ] CI รันเขียวบน PR แรก

### Phase 1 — Auth + ค้นหา/ดู Event (1-2 วัน)
งาน: schema เริ่มต้น (User, Venue, Event, Showtime) ใน `apps/api`, endpoint `/auth/register` `/auth/login` ออก JWT เป็น httpOnly cookie, หน้า register/login และหน้าค้นหา+รายละเอียดรอบใน `apps/web` ที่เรียก API เหล่านี้
Checklist:
- [ ] สมัคร/ล็อกอินได้จริงจากหน้า frontend จริง (ไม่ใช่แค่ยิง API ตรง), password ถูก hash (bcrypt/argon2) ไม่เก็บ plaintext
- [ ] ค้นหา event ตามวันที่/สถานที่ได้ผลลัพธ์ถูกต้องผ่าน frontend
- [ ] มี unit test ฝั่ง `apps/api` ครอบ auth logic อย่างน้อย happy path + wrong password

### Phase 2 — เลือกที่นั่ง + Seat Hold (2 วัน)
งาน: Seat/SeatMap schema, ผังที่นั่งแบบ real-time-ish, Redis hold + TTL, สร้าง Booking(PENDING_PAYMENT)
Checklist:
- [ ] จองที่นั่งเดียวกันพร้อมกัน 2 คน → มีคนเดียวได้ที่นั่ง (ทดสอบ concurrency จริง ไม่ใช่แค่ทฤษฎี)
- [ ] hold หมดเวลาแล้วที่นั่งกลับมาว่างอัตโนมัติ
- [ ] มี e2e test (Playwright) ครอบ flow เลือกที่นั่ง→สร้าง booking — ทำแล้ว 13 ส.ค. 2569 แต่ครอบ flow เต็มเส้น (ค้นหา→เลือกที่นั่ง→จ่ายเงิน→เห็นตั๋ว) ไม่ใช่แค่ถึงขั้นสร้าง booking เพราะรอทำตอน Phase 4 เสร็จแล้วมี flow ครบให้ทดสอบจริง — `tests/e2e/booking-flow.spec.ts`, สั่งด้วย `npm run test:e2e`

### Phase 3 — ชำระเงิน (2 วัน)
งาน: integrate Stripe Checkout, webhook handler + signature verification, อัพเดตสถานะ booking/seat แบบ transaction
Checklist:
- [ ] webhook ปฏิเสธ request ที่ signature ไม่ถูกต้อง (ทดสอบยิงปลอมแล้วต้อง reject)
- [ ] จ่ายเงินสำเร็จ → booking เป็น PAID, seat เป็น BOOKED ใน transaction เดียว ไม่มี state ค้างครึ่งๆ กลาง
- [ ] จำลอง webhook ยิงซ้ำ (duplicate event) แล้วระบบไม่สร้าง ticket ซ้ำ (idempotency)

### Phase 4 — ออกตั๋ว + แจ้งเตือน (1 วัน)
งาน: generate QR ผูก booking id, หน้า "ตั๋วของฉัน", ส่งอีเมลยืนยัน
Checklist:
- [ ] QR สแกนแล้ว decode ได้ค่าที่ตรวจสอบย้อนกลับไป booking จริงได้
- [ ] อีเมลส่งถึงจริงในสภาพแวดล้อม staging
- [ ] ตั๋วที่ยังไม่จ่ายเงินเข้าไม่ถึงหน้าตั๋ว (guard สิทธิ์ถูกต้อง)

### Phase 5 — Admin Panel (2 วัน)
งาน: CRUD event/showtime/seat map, รายการ booking+filter, ยกเลิก/คืนเงิน+audit log, dashboard สรุปยอด
Checklist:
- [ ] หน้า admin ทุกหน้าถูก guard ด้วย role check จริง (ทดสอบเข้าด้วย user ทั่วไปต้องโดนเด้ง)
- [ ] ทุก action ที่แก้ข้อมูล (ยกเลิก/คืนเงิน) มี record ใน AdminAuditLog
- [ ] คืนเงินแล้ว seat กลับมาว่างถูกต้อง, ไม่ทำให้ booking อื่นเพี้ยน

### Phase 6 — Hardening + Deploy (1-2 วัน)
งาน: load test เบื้องต้น flow จอง, ตรวจ security header/rate-limit หน้า login, เตรียม production env, deploy
Checklist:
- [ ] rate-limit endpoint login/booking กันสแปม
- [ ] มี rollback plan (migration ย้อนกลับได้, ดู log deploy ได้)
- [ ] คนตรวจสอบ (ไม่ใช่ agent) เป็นคน trigger deploy จริงครั้งแรก

---

## 7. Task Prompt จริงสำหรับ Phase 1

ใช้พรอมป์นี้สั่ง agent ตรงๆ (แก้ path/ชื่อ repo ตามจริง):

```
บริบท: นี่คือโปรเจกต์ระบบจองตั๋ว อ่าน CLAUDE.md ในโฟลเดอร์นี้ก่อนเริ่มงานทุกครั้ง แล้วทำตามกติกาทั้งหมดในนั้น

งานของคุณตอนนี้คือ Phase 1: Auth + ค้นหา/ดู Event

ขอบเขตงาน:
1. ตั้ง npm workspaces: `apps/web` (Next.js 16, App Router, TypeScript) และ `apps/api` (Express, TypeScript) ถ้ายังไม่มี
2. เพิ่ม model User, Venue, Event, Showtime ใน `apps/api/prisma/schema.prisma` ตาม schema ที่อธิบายไว้ใน Ticket-Booking-System-Plan.md หัวข้อ 5 (เฉพาะ 4 ตารางนี้ ยังไม่ต้องทำ Seat/Booking/Payment)
3. ใน `apps/api` สร้าง endpoint `POST /auth/register` และ `POST /auth/login` — hash password ด้วย bcrypt ห้ามเก็บ plaintext เด็ดขาด, login สำเร็จให้ set JWT เป็น httpOnly cookie
4. ตั้ง CORS บน `apps/api` ให้รับ request จาก origin ของ `apps/web` เท่านั้น
5. ใน `apps/web` สร้างหน้า login/register ที่เรียก endpoint ข้างต้น
6. ใน `apps/web` สร้างหน้า /events แสดงรายการ event ทั้งหมด พร้อม filter ตามวันที่และสถานที่ โดยเรียก endpoint `GET /events` ที่ต้องสร้างใน `apps/api` (query จาก Showtime + Venue)
7. สร้างหน้า /events/[id] ใน `apps/web` แสดงรายละเอียด event และรอบ (showtime) ที่มี โดยเรียก `GET /events/:id`

ข้อกำหนดเพิ่มเติม (บังคับ ไม่ใช่ทางเลือก):
- เขียน unit test ฝั่ง `apps/api` ครอบ auth logic อย่างน้อย 2 เคส: login สำเร็จ, login ด้วย password ผิด
- รัน `npm run build && npm test` ให้ผ่านทั้ง 2 app ก่อนบอกว่าเสร็จ
- ห้ามแก้ schema ของตารางอื่นที่ยังไม่เกี่ยวกับ phase นี้
- ห้ามเขียน business logic (validate, query) ฝั่ง `apps/web` — หน้าที่ของ frontend คือเรียก API แล้วแสดงผลเท่านั้น
- ถ้าเจอจุดที่ไม่แน่ใจ (เช่น field ไหนควร required/optional) ให้เลือกทางที่ง่ายที่สุดที่ยังถูกต้อง แล้วบันทึกไว้ในสรุปท้ายงานว่าเลือกเพราะอะไร แทนที่จะหยุดถามทุกจุดเล็กๆ

เมื่อเสร็จ ให้สรุป:
- ไฟล์ไหนถูกสร้าง/แก้บ้าง
- ผลการรัน build/test
- สิ่งที่ตัดสินใจเองระหว่างทางและเหตุผล
- สิ่งที่อยากให้คน review เพิ่มเติมก่อนไป phase ถัดไป
```

---

## 8. จุดที่ AI ห้ามตัดสินใจเอง ต้องให้คน Review/Approve ก่อน

- **Payment provider และ credential**: เลือก Stripe/Omise/2C2P, ราคา, ค่าธรรมเนียม, refund policy — เป็นการตัดสินใจทางธุรกิจ ไม่ใช่เทคนิค
- **Production database migration**: agent เขียน migration ได้ แต่การ "รัน" กับ DB จริงต้องเป็นคนกดเอง
- **Deploy ขึ้น production / merge เข้า main**: agent เปิด PR ได้ แต่การ approve+merge+deploy ต้องเป็นคน
- **การลบข้อมูล** (user, booking, payment) แม้จะดูเหมือนข้อมูลทดสอบ
- **การปิด/ข้าม security check** เช่น webhook signature verification, auth guard บนหน้า admin แม้จะอ้างว่าเพื่อ debug ชั่วคราว
- **การเปลี่ยนแปลงที่กระทบผู้ใช้จริง** เช่น ยกเลิก booking ของคนอื่น, เปลี่ยนเวลา hold ที่นั่งที่ตกลงกันไว้แล้ว
- **การเพิ่ม dependency/service ใหม่** (queue, microservice, MCP ใหม่) ที่ยังไม่ได้ระบุไว้ใน CLAUDE.md

หลักการ: **ทุกอย่างที่ rollback ยากหรือกระทบเงิน/ข้อมูลจริง → คนต้องกดปุ่มสุดท้ายเสมอ**

---

## 9. แผนรับมือกรณี AI บอกว่าเสร็จแล้ว แต่ตรวจแล้วไม่ถูกต้อง/ไม่ครบ

1. **อย่าเชื่อคำว่า "เสร็จแล้ว" เฉยๆ** — ทุก phase ต้องรัน checklist ในข้อ 6 จริงก่อนปิดงาน (build, test, e2e, manual click-through อย่างน้อย 1 รอบ)
2. **ขอ diff/summary เสมอ**: ให้ agent สรุปไฟล์ที่แก้ + ผลรัน test แนบมาด้วยทุกครั้ง ถ้าไม่มีผลรัน test แนบ = ยังไม่เสร็จ
3. **ถ้าตรวจพบว่าไม่ผ่าน checklist ข้อไหน** ให้ส่ง prompt กลับไปแบบเจาะจง เช่น "checklist ข้อ 2 ของ Phase 2 ไม่ผ่าน: ทดสอบจองที่นั่งเดียวกันพร้อมกัน 2 tab แล้วทั้งคู่จองติด แก้เฉพาะจุดนี้ อย่าแตะโค้ดส่วนอื่น" — ห้ามสั่งทำใหม่ทั้งหมด จะเสียเวลาและเสี่ยงพังจุดที่เคยถูกต้อง
4. **ใช้ agent/คนที่สองมาตรวจ (second-pass review)** สำหรับ phase ที่แตะเงิน/security (Phase 3, 5) โดยเฉพาะ — ให้ review แยกจาก agent ที่เขียนโค้ด ลดโอกาส "ตรวจงานตัวเอง"
5. **Branch แยกต่อ phase + commit เล็กๆ**: ถ้า phase ไหนพังหลัง merge ให้ revert ทั้ง branch ได้ทันทีโดยไม่กระทบ phase ก่อนหน้า
6. **เก็บ pattern ความผิดพลาดที่เจอบ่อยไว้ใน CLAUDE.md**: ถ้า agent พลาดเรื่องเดิมซ้ำ (เช่น ลืม signature verification) ให้เพิ่มกฎนั้นเป็นข้อบังคับถาวรใน CLAUDE.md แทนที่จะเตือนปากเปล่าทุกครั้ง
7. **กำหนด "3 ครั้งแล้วหยุด"**: ถ้า agent แก้จุดเดียวกันแล้วยังไม่ผ่านเกิน 2-3 รอบ ให้คนเข้ามาดูโค้ดเองแทนการสั่งซ้ำไปเรื่อยๆ — มักแปลว่าปัญหาอยู่ลึกกว่าที่ prompt บอกได้
