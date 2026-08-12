# 7. Task Prompt จริงสำหรับ Phase 1

ใช้พรอมป์นี้สั่ง agent ตรงๆ (แก้ path/ชื่อ repo ตามจริง):

```
บริบท: นี่คือโปรเจกต์ระบบจองตั๋ว อ่าน CLAUDE.md ในโฟลเดอร์นี้ก่อนเริ่มงานทุกครั้ง แล้วทำตามกติกาทั้งหมดในนั้น

งานของคุณตอนนี้คือ Phase 1: Auth + ค้นหา/ดู Event

ขอบเขตงาน:
1. ตั้ง npm workspaces: `apps/web` (Next.js 16, App Router, TypeScript) และ `apps/api` (Express, TypeScript) ถ้ายังไม่มี
2. เพิ่ม model User, Venue, Event, Showtime ใน `apps/api/prisma/schema.prisma` ตาม schema ที่อธิบายไว้ใน docs/deliverables/05-database-schema.md (เฉพาะ 4 ตารางนี้ ยังไม่ต้องทำ Seat/Booking/Payment)
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

## See also

- [`05-database-schema.md`](05-database-schema.md) — schema ที่พรอมป์นี้อ้างถึง
- [`06-phase-plan.md`](06-phase-plan.md) — checklist ตรวจรับ Phase 1
- [`../../Ticket-Booking-System-Plan.md`](../../Ticket-Booking-System-Plan.md) — สารบัญเอกสารทั้งหมด
