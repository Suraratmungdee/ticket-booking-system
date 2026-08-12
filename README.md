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
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local

# 3. เปิดฐานข้อมูล
docker compose up -d postgres

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

## คำสั่งที่ใช้บ่อย

```bash
npm run build     # build ทั้ง 2 app (ต้องผ่านก่อนถือว่างานเสร็จ)
npm test          # รัน unit test ทั้งหมด
npm run dev:api   # รันเฉพาะ backend
npm run dev:web   # รันเฉพาะ frontend
```

## API ที่มีตอนนี้ (Phase 1)

| Method | Path | ทำอะไร |
|---|---|---|
| `POST` | `/auth/register` | สมัครสมาชิก — hash รหัสผ่านด้วย bcrypt → `201` |
| `POST` | `/auth/login` | เข้าสู่ระบบ — set JWT เป็น httpOnly cookie → `200` |
| `GET` | `/events` | รายการ event, filter ด้วย `?date=YYYY-MM-DD` และ `?venueId=` |
| `GET` | `/events/:id` | รายละเอียด event + รอบทั้งหมด |
| `GET` | `/health` | health check |

รหัสผ่านไม่เคยถูกเก็บเป็น plaintext และ JWT ไม่เคยถูกส่งกลับใน response body

## หมายเหตุด้านความปลอดภัย

- `.env` และ `.env.local` อยู่ใน `.gitignore` — **ห้าม commit** มีเฉพาะ `.env.example` ที่เป็นค่า placeholder
- ตอน deploy production ต้องตั้ง `JWT_SECRET` จริง มิฉะนั้น backend จะไม่ยอมสตาร์ท
- cookie ใช้ `SameSite=Lax` ตอน dev และสลับเป็น `None` + `Secure` อัตโนมัติเมื่อ `NODE_ENV=production` (รองรับกรณี deploy คนละ domain)
- ก่อน deploy จริงครั้งแรก อ่าน [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — environment variables ที่ต้องตั้ง, deploy order, rollback, และสิ่งที่ยังไม่เคยถูก verify

## สถานะงาน

**Phase 1 เสร็จแล้ว** — auth + ค้นหา/ดู event, unit test 11 เคสผ่าน, build ผ่านทั้ง 2 app, ตรวจ manual ครบตาม checklist

Phase ถัดไป (ยังไม่ทำ): เลือกที่นั่ง + seat hold ด้วย Redis → ชำระเงินผ่าน Stripe → ออกตั๋ว QR → admin panel
