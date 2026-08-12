# CLAUDE.md — Ticket Booking System

คำแนะนำนี้คือ context หลักที่ Claude Code (หรือ AI coding agent อื่น) ต้องอ่านและปฏิบัติตามทุกครั้งก่อนแก้โค้ดในโปรเจกต์นี้

## 1. โปรเจกต์คืออะไร

ระบบจองตั๋ว (concert / เที่ยวรถ / หนัง ฯลฯ — ใช้โครงสร้างเดียวกัน) ให้ผู้ใช้ค้นหารอบ เลือกที่นั่ง จองและชำระเงิน แล้วได้ตั๋ว (QR code) กลับมา มี Admin panel สำหรับจัดการ event/รอบ/ที่นั่ง/คำสั่งจอง

## 2. Tech Stack (ตายตัว ห้ามเปลี่ยนโดยไม่ถาม)

- **Frontend**: Next.js 16 (App Router) + TypeScript — UI เท่านั้น ไม่มี business logic, เรียก backend ผ่าน REST API
- **Backend**: Node.js + Express + TypeScript — REST API แยก service ต่างหากจาก frontend
- PostgreSQL + Prisma ORM (อยู่ฝั่ง backend เท่านั้น frontend ห้ามต่อ DB ตรง)
- Auth: backend ออก JWT เอง (login แล้ว set เป็น httpOnly cookie) — ไม่ใช้ NextAuth เพราะ NextAuth ผูกกับ Next.js server ฝั่งเดียว ใช้กับ backend แยกไม่สะดวก
- `cors` (npm package มาตรฐาน) บน Express — จำกัด origin เฉพาะ URL ของ frontend เท่านั้น
- Redis (Upstash) — ใช้ทำ seat lock ชั่วคราวตอนจอง (TTL 5 นาที) เท่านั้น ห้ามใช้ทำอย่างอื่นถ้ายังไม่จำเป็น
- Stripe (test mode) — ชำระเงิน เก็บ webhook signature verification ไว้เป็น critical path (webhook รับที่ backend)
- ไลบรารี `qrcode` — สร้าง QR ตั๋วหลังชำระเงินสำเร็จ
- Tailwind CSS — UI
- Vitest — unit test (ทั้งสอง app), Playwright — e2e test เฉพาะ flow จอง-จ่าย-ได้ตั๋ว (ยิงผ่าน frontend จริง)
- npm workspaces (native ใน npm ไม่ต้องเพิ่ม tool) — จัดการ monorepo 2 app ใน repo เดียว

เหตุผล: แยก frontend/backend เพราะทีมถนัด Express และเผื่อ backend ถูกใช้กับ client อื่นในอนาคต (mobile) — แลกกับความยุ่งยากเพิ่มขึ้นเรื่อง CORS และ deploy 2 service ซึ่งยอมรับได้

ห้ามเพิ่ม dependency ใหม่ (message queue, microservice เพิ่มอีกตัว, GraphQL, Turborepo/Nx, ฯลฯ) จนกว่าจะเจอปัญหาจริงที่ stack ปัจจุบันแก้ไม่ได้ — npm workspaces พอสำหรับ 2 app นี้แล้ว ถ้าคิดว่าจำเป็นต้องเพิ่มอะไร ให้หยุดแล้วถามก่อน ห้ามตัดสินใจเอง

## 3. โครงสร้างโปรเจกต์ (npm workspaces monorepo)

```
/apps
  /web                 # Next.js 16 — frontend เท่านั้น
    /app               # App Router (pages, ไม่มี /api route handler แล้ว)
    /lib               # fetch wrapper เรียก backend API เท่านั้น ไม่มี business logic
  /api                 # Express backend
    /src
      /routes          # Express route handlers (REST)
      /lib             # business logic ที่ใช้ร่วมกัน (booking, payment, seat-lock)
      /middleware      # auth guard (JWT verify), role check
    /prisma
      schema.prisma
      /migrations
/tests
  /unit                # ครอบทั้ง apps/web และ apps/api
  /e2e                 # Playwright ยิงผ่าน frontend จริง เรียก backend จริง
package.json           # root, ประกาศ workspaces: ["apps/*"]
```

กฎ: logic เกี่ยวกับเงิน/ที่นั่ง/สถานะการจอง ต้องอยู่ใน `apps/api/src/lib` เป็นฟังก์ชันเดียวที่ทุก route เรียกใช้ ห้ามก็อปโค้ด validate ซ้ำในแต่ละ route, ห้ามเขียน business logic ฝั่ง frontend เด็ดขาด

## 4. กติกาการเขียนโค้ด

1. อ่านโค้ดเดิมก่อนเขียนใหม่เสมอ — ถ้ามี helper/util ที่ทำสิ่งเดียวกันอยู่แล้วให้ใช้ของเดิม ห้ามเขียนซ้ำ
2. ทุก endpoint ที่แตะเงินหรือที่นั่ง ต้อง validate input และเช็ค state (เช่น ที่นั่งยังว่างจริงไหม, booking ยังไม่หมดเวลา lock ไหม) ก่อนเขียนลง DB เสมอ ห้ามเชื่อ input จาก client เฉยๆ
3. ห้าม hardcode ราคา, ค่าธรรมเนียม, หรือ business rule (เช่น เวลา hold ที่นั่ง) ในหลายที่ — เก็บเป็นค่าคงที่ที่เดียวใน `/lib/config.ts`
4. ทุก migration ต้องเป็นแบบ additive/reversible เท่าที่ทำได้ ห้าม `DROP COLUMN`/`DROP TABLE` โดยไม่แจ้งเตือนและรอ approve
5. ห้าม commit secret/API key ลงโค้ดหรือ `.env.example` — ใช้ `.env` (อยู่ใน `.gitignore`) เท่านั้น
6. เขียนโค้ดที่สั้นที่สุดที่ทำงานถูกต้อง ไม่เพิ่ม abstraction/config ที่ยังไม่มีใครใช้ (YAGNI) — ถ้าตัดมุมใดที่มีข้อจำกัดชัดเจน ให้ใส่ comment `// LIMITATION:` อธิบายว่าจำกัดตรงไหนและควรอัพเกรดเมื่อไหร่
7. ทุก logic ที่มีเงื่อนไข/สาขา (การจอง, การจ่ายเงิน, การล็อกที่นั่ง) ต้องมี test อย่างน้อย 1 เคสที่ fail ได้จริงถ้า logic พัง

## 5. สิ่งที่ห้าม Agent ตัดสินใจเองเด็ดขาด

ดูรายละเอียดเต็มในเอกสาร `docs/deliverables/08-human-review-required.md` แต่สรุปสั้นๆ ที่ต้องจำ:

- ห้าม deploy ขึ้น production หรือ merge เข้า branch `main` เอง
- ห้ามรัน migration กับฐานข้อมูล production เอง
- ห้ามเปลี่ยน payment provider, ราคา, ค่าธรรมเนียม, หรือ refund policy เอง
- ห้ามลบข้อมูลจริง (user, booking, payment) แม้จะดูเหมือนข้อมูลทดสอบ
- ห้ามปิด/ข้าม signature verification ของ payment webhook แม้เพื่อ "debug ชั่วคราว"

ถ้าเจอสถานการณ์เหล่านี้ ให้หยุดและถามมนุษย์ก่อนเสมอ

## 6. Definition of Done ต่อ 1 งาน

งานจะถือว่าเสร็จก็ต่อเมื่อครบทุกข้อ ไม่ใช่แค่ "โค้ดรันได้":

1. `npm run build` ผ่านทั้ง `apps/web` และ `apps/api` ไม่มี type error
2. `npm test` ผ่านทั้งหมด (ทั้งสอง app) รวม test ใหม่ที่เพิ่มสำหรับ logic ใหม่
3. มี manual/e2e check ตาม checklist ของ phase นั้น (ดูเอกสารแผนงาน)
4. สรุปสั้นๆ ท้ายงานว่า "ทำอะไรไป / ข้ามอะไรไปโดยตั้งใจ / ต้องให้คน review อะไรเพิ่ม"

ถ้าข้อใดไม่ผ่าน ห้ามรายงานว่า "เสร็จแล้ว" ให้รายงานสถานะจริงพร้อมสิ่งที่ค้าง
