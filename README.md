# Ticket Booking System

ระบบจองตั๋ว (คอนเสิร์ต / รอบฉาย / เที่ยวเดินทาง) — monorepo แยก frontend กับ backend REST API

เอกสารประกอบ:
- `CLAUDE.md` — context/กติกาสำหรับ AI coding agent
- `Ticket-Booking-System-Plan.md` — แผนออกแบบระบบและแบ่ง phase
- `docs/superpowers/plans/` — แผน implementation รายงานละเอียดต่อ phase

## Tech Stack

| ส่วน | ใช้อะไร |
|---|---|
| Frontend | Next.js 16 (App Router) + TypeScript + Tailwind CSS v4 |
| Backend | Node.js + Express 5 + TypeScript (REST API แยก service) |
| Database | PostgreSQL + Prisma ORM v6 |
| Auth | JWT ที่ backend ออกเอง เก็บใน httpOnly cookie (ไม่ใช้ NextAuth) |
| Test | Vitest |
| Monorepo | npm workspaces |

## โครงสร้าง

```
apps/web     Next.js — UI เท่านั้น ไม่มี business logic ไม่ต่อ DB ตรง
apps/api     Express — business logic + Prisma ทั้งหมดอยู่ที่นี่
  src/lib      logic ที่ใช้ร่วมกัน (auth, events, config, prisma)
  src/routes   REST handlers (บาง เรียก lib)
  prisma       schema + migrations + seed
tests/unit   unit test ครอบ apps/api
```

## เริ่มใช้งาน

ต้องมี **Node.js 22+** และ **Docker**

```bash
# 1. ติดตั้ง dependencies (ทั้ง 2 workspace)
npm install

# 2. เตรียมไฟล์ env (ค่า default ตรงกับ docker-compose อยู่แล้ว)
#    ไม่ต้องไปหา API key จริงจากที่ไหนเลย — ทุก field ที่เกี่ยวกับบริการภายนอก
#    มีค่า default ที่ทำให้ระบบทำงานได้ครบ (ดูรายละเอียดด้านล่าง)
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local

# 2.1 (ทางเลือก) อยากได้บัญชี admin ไว้ทดสอบหน้า /admin ด้วย
#     เปิด apps/api/.env แล้วใส่ค่าให้ SEED_ADMIN_EMAIL และ SEED_ADMIN_PASSWORD
#     ก่อนรันขั้นตอนที่ 4 — ถ้าเว้นว่างไว้ ระบบจะทำงานได้ปกติแค่ไม่มี admin
#     account ให้ล็อกอิน

# 3. เปิดฐานข้อมูลและ Redis (npm test ต้องมีทั้งคู่ — integration test ต่อจริง)
docker compose up -d

# 4. สร้างตารางและใส่ข้อมูลตัวอย่าง
cd apps/api
npx prisma migrate dev
npx prisma db seed
cd ../..

# 5. รัน (คนละ terminal)
npm run dev:api    # http://localhost:4000
npm run dev:web    # http://localhost:3000
```

เปิด http://localhost:3000 แล้วลองสมัครสมาชิก → เข้าสู่ระบบ → ดูรายการ event

> ⚠️ `apps/web` ต้องรันที่พอร์ต 3000 เพราะ CORS ของ backend จำกัด origin ไว้ตาม `FRONTEND_ORIGIN`

### ไม่ต้องมี API key จริงเพื่อทดสอบระบบ

ทั้ง flow จองตั๋ว — ค้นหา, เลือกที่นั่ง, **จ่ายเงิน**, ได้ตั๋ว QR, และหน้า admin — ทดสอบได้ครบโดยไม่ต้องสมัครบริการภายนอกเลยสักตัว:

- **จ่ายเงิน**: `.env.example` ตั้ง `PAYMENT_PROVIDER="mock"` เป็นค่า default อยู่แล้ว ระบบจึงจำลองการจ่ายเงินเองผ่านหน้า `/mock-pay/...` (มี banner "หน้าจำลองการชำระเงิน" กำกับชัดเจน) ไม่มีการเรียก Stripe จริงเลยในโค้ด — ดู `docs/DEPLOYMENT.md` หัวข้อ `PAYMENT_PROVIDER`
- **อีเมลยืนยัน**: `RESEND_API_KEY` เว้นว่างได้ ระบบจะ log เนื้อหาอีเมลที่ "จะส่ง" ออกทาง console แทนการส่งจริง (ดูใน terminal ที่รัน `npm run dev:api`) ไม่กระทบ flow การจองหรือได้ตั๋วแต่อย่างใด
- **บัญชี admin**: ตั้งเองได้ตามขั้นตอน 2.1 ด้านบน ไม่ต้องขอจากใคร

## คำสั่งที่ใช้บ่อย

```bash
npm run build     # build ทั้ง 2 app (ต้องผ่านก่อนถือว่างานเสร็จ)
npm test          # unit + integration test ของ apps/api (ต้องมี Postgres + Redis รันอยู่)
npm run dev:api   # รันเฉพาะ backend
npm run dev:web   # รันเฉพาะ frontend
npm run test:e2e  # Playwright: flow ค้นหา→เลือกที่นั่ง→จ่ายเงิน→เห็นตั๋วจริง ผ่านเบราว์เซอร์จริง
```

`npm run test:e2e` สั่งครั้งแรกต้องติดตั้ง browser ก่อนหนึ่งครั้ง: `npx playwright install --with-deps chromium` — ถ้า `dev:api`/`dev:web` รันอยู่แล้วจะใช้ของที่รันอยู่ ไม่รันซ้ำ ถ้ายังไม่รัน Playwright จะเปิดให้เองแล้วปิดเมื่อเทสต์จบ ต้องมี Postgres + Redis ขึ้นอยู่ก่อนเสมอ (เทสต์สร้าง venue/event/showtime/ที่นั่ง/user ของตัวเองแบบแยกจากข้อมูล seed แล้วลบทิ้งเองท้ายเทสต์ ไม่แตะข้อมูลอื่น)

## API ที่มีตอนนี้ (ครบ 6 phase)

| Method | Path | Auth | ทำอะไร |
|---|---|---|---|
| `POST` | `/auth/register` | – | สมัครสมาชิก — hash รหัสผ่านด้วย bcrypt → `201` |
| `POST` | `/auth/login` | – | เข้าสู่ระบบ — set JWT เป็น httpOnly cookie → `200`, rate-limited |
| `GET` | `/auth/me` | ✅ | ใครล็อกอินอยู่ (role อ่านจาก DB สดทุกครั้ง ไม่เชื่อ token) |
| `POST` | `/auth/logout` | – | ล้าง session cookie → `204` |
| `GET` | `/events` | – | รายการ event, filter ด้วย `?date=YYYY-MM-DD` และ `?venueId=` |
| `GET` | `/events/:id` | – | รายละเอียด event + รอบทั้งหมด |
| `GET` | `/showtimes/:id/seats` | – | ผังที่นั่งพร้อมสถานะ (รวม hold ชั่วคราวจาก Redis) |
| `POST` | `/showtimes/:id/seats/hold` | ✅ | ล็อกที่นั่ง + สร้าง booking `PENDING_PAYMENT` |
| `GET` | `/bookings/:id` | ✅ เจ้าของ | สถานะ booking + เวลาที่เหลือก่อน hold หมดอายุ |
| `POST` | `/bookings/:id/checkout` | ✅ เจ้าของ | สร้าง checkout session |
| `POST` | `/webhooks/payment` | signature | รับผลชำระเงิน → อัปเดต `PAID` แบบ idempotent |
| `GET` | `/me/tickets` | ✅ | ตั๋วทั้งหมดของผู้ใช้ |
| `GET` | `/tickets/:id` | ✅ เจ้าของ | ตั๋วใบเดียว + QR payload |
| `GET/POST/PATCH` | `/admin/venues`, `/admin/events`, `/admin/showtimes`, `/admin/seatmaps` | ✅ ADMIN | CRUD |
| `GET` | `/admin/bookings` | ✅ ADMIN | รายการ booking + filter |
| `GET` | `/admin/dashboard` | ✅ ADMIN | สรุปยอดขาย/ที่นั่งคงเหลือต่อรอบ |
| `GET`/`POST` | `/mock-provider/sessions/:providerRef[/complete]` | – | จำลอง payment provider — mount เฉพาะตอน `PAYMENT_PROVIDER=mock` |
| `GET` | `/health` | – | health check |

รายชื่อ field/validation ทั้งหมดต่อ endpoint: `Ticket-Booking-System-Plan.md` หัวข้อ 5.1 รหัสผ่านไม่เคยถูกเก็บเป็น plaintext และ JWT ไม่เคยถูกส่งกลับใน response body

## หมายเหตุด้านความปลอดภัย

- `.env` และ `.env.local` อยู่ใน `.gitignore` — **ห้าม commit** มีเฉพาะ `.env.example` ที่เป็นค่า placeholder
- ตอน deploy production ต้องตั้ง `JWT_SECRET` จริง มิฉะนั้น backend จะไม่ยอมสตาร์ท
- cookie ใช้ `SameSite=Lax` ตอน dev และสลับเป็น `None` + `Secure` อัตโนมัติเมื่อ `NODE_ENV=production` (รองรับกรณี deploy คนละ domain)
- ก่อน deploy จริงครั้งแรก อ่าน [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — environment variables ที่ต้องตั้ง, deploy order, rollback, และสิ่งที่ยังไม่เคยถูก verify

## สถานะงาน

**ครบทั้ง 6 phase** — **189 unit test + 10 integration test + 1 e2e (Playwright) ผ่าน**, build ผ่านทั้ง 2 app

| Phase | ทำอะไร |
|---|---|
| 1 | auth (bcrypt + JWT ใน httpOnly cookie), ค้นหา/ดู event |
| 2 | ผังที่นั่ง, seat hold ใน Redis (TTL 5 นาที), สร้าง booking — กันที่นั่งซ้อนด้วย row lock ใน Postgres |
| 3 | ชำระเงิน: checkout session, webhook พร้อมตรวจลายเซ็น HMAC จาก raw body, idempotency ด้วย unique constraint |
| 4 | ออกตั๋ว QR (payload เซ็นด้วย HMAC) ใน transaction เดียวกับตอน booking เป็น `PAID`, หน้าตั๋วของฉัน, อีเมลยืนยันผ่าน Resend |
| 5 | Admin panel: CRUD event/รอบ/ผังที่นั่ง, รายการจอง + filter, audit log, dashboard ยอดขาย |
| 6 | Security headers, rate limit (login + จอง), สคริปต์ load test, [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) |

เอกสาร spec / plan / ผล review ของทุก phase อยู่ใน [`docs/superpowers/`](docs/superpowers/)
