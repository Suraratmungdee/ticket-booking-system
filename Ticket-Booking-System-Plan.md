# แผนออกแบบระบบจองตั๋ว (Ticket Booking System) ด้วย AI Coding Agent

Agent ที่เลือกใช้: **Claude Code** | Stack: Next.js 16 (frontend) + Node.js/Express (backend API แยก service) + TypeScript + PostgreSQL (Prisma) + Redis + Stripe — เหตุผลอยู่ใน `CLAUDE.md` หัวข้อ 2

ไฟล์ที่ส่งมอบคู่กับเอกสารนี้:
- `CLAUDE.md` — context/instruction file เต็มรูปแบบ (ข้อ 1)
- `commands-new-endpoint.md` — custom slash command ของ Claude Code (ข้อ 2, วางที่ `.claude/commands/new-endpoint.md` ในโปรเจกต์จริง)

---

## 3. Plugin / MCP / Tool เสริมที่แนะนำ

| เครื่องมือ | เหตุผล |
|---|---|
| **Postgres MCP server** | ให้ agent query/ตรวจ schema จริงได้โดยตรงแทนการเดา field name จาก `schema.prisma` เฉยๆ ลดบั๊กจาก field ไม่ตรง |
| **GitHub MCP** | ให้ agent เปิด PR, อ่าน CI status, comment ได้เอง แต่ **ห้ามให้สิทธิ์ merge อัตโนมัติ** (ดูข้อ 8) |
| **Playwright MCP** | รัน e2e test จริงในเบราว์เซอร์สำหรับ flow ค้นหา→จอง→จ่าย→ได้ตั๋ว ซึ่งเป็น critical path ที่ test ด้วย unit test อย่างเดียวไม่พอ |
| **Stripe CLI / Stripe MCP (ถ้ามี)** | ยิง webhook event จำลอง (`payment_intent.succeeded` ฯลฯ) ทดสอบ flow ออกตั๋วโดยไม่ต้องจ่ายเงินจริงทุกครั้ง |
| **Sentry (หรือ log tool คล้ายกัน)** | ไม่ใช่ MCP แต่ควรติดตั้งตั้งแต่ phase แรกของ payment เพื่อจับ error ที่เกิดใน webhook/production ซึ่งเป็นจุดที่แก้ทีหลังยากที่สุด |

จงใจไม่แนะนำ: message-queue MCP, Kubernetes/infra MCP, custom internal-tool MCP — โปรเจกต์ขนาดนี้ยังไม่ถึงจุดที่ต้องใช้ (YAGNI) เพิ่มทีหลังได้เมื่อ scale จริงบังคับ

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

ตารางหลัก (Prisma-style, ย่อ type):

```
User          (id, email, password_hash, name, role[USER|ADMIN], created_at)
Venue         (id, name, address)
Event         (id, title, description, venue_id -> Venue)
Showtime      (id, event_id -> Event, start_time, end_time, status)
SeatMap       (id, showtime_id -> Showtime, zone_name, price)
Seat          (id, seat_map_id -> SeatMap, row, number, status[AVAILABLE|HELD|BOOKED])
Booking       (id, user_id -> User, showtime_id -> Showtime, status[PENDING_PAYMENT|PAID|EXPIRED|CANCELLED], total_price, created_at, expires_at)
BookingSeat   (id, booking_id -> Booking, seat_id -> Seat)      -- join table จอง N ที่นั่งต่อ booking
Payment       (id, booking_id -> Booking, provider, provider_ref, amount, status, paid_at)
Ticket        (id, booking_id -> Booking, qr_code_payload, issued_at)
AdminAuditLog (id, admin_id -> User, action, target_type, target_id, created_at)
```

ความสัมพันธ์สำคัญ:
- `Event 1—N Showtime`, `Showtime 1—N Seat` (ผ่าน SeatMap)
- `Booking N—N Seat` ผ่าน `BookingSeat` (1 booking จองได้หลายที่นั่ง)
- `Booking 1—1 Payment` (MVP: 1 booking จ่ายครั้งเดียวจบ), `Booking 1—1 Ticket`
- `Seat.status` ต้อง sync กับ `Booking.status` เสมอผ่าน transaction เดียว ห้ามอัพเดตแยกกันคนละ query (เสี่ยง race condition ที่นั่งซ้อน)

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
- [ ] มี e2e test (Playwright) ครอบ flow เลือกที่นั่ง→สร้าง booking

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
