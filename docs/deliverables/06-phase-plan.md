# 6. แผนการทำงานแบ่ง Phase

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

## สถานะจริง

ครบทั้ง 7 phase (0-6) แล้ว — ดูสรุปผลการรันจริง (build/test/e2e) ใน [`../../README.md`](../../README.md) หัวข้อ "สถานะงาน" และรายงานละเอียดต่อ phase ใน [`../superpowers/plans/`](../superpowers/plans/)

## See also

- [`07-phase1-task-prompt.md`](07-phase1-task-prompt.md) — พรอมป์จริงที่ใช้สั่ง Phase 1
- [`09-recovery-plan.md`](09-recovery-plan.md) — วิธีใช้ checklist นี้ตรวจรับงานแต่ละ phase
- [`../../Ticket-Booking-System-Plan.md`](../../Ticket-Booking-System-Plan.md) — สารบัญเอกสารทั้งหมด
