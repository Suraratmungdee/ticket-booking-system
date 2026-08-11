# Phase 2 — Seat Selection + Seat Hold + Booking

**สถานะ:** อนุมัติแล้ว 10 ส.ค. 2026 · ต่อจาก Phase 1 (auth + ดู event) ที่เสร็จแล้ว

## เป้าหมาย

ให้ผู้ใช้ที่ล็อกอินแล้วเลือกที่นั่งจากผังของรอบหนึ่ง แล้วสร้างคำสั่งจองสถานะ `PENDING_PAYMENT` ที่กันที่นั่งไว้ 5 นาที โดย**การันตีว่าคน 2 คนที่กดที่นั่งเดียวกันพร้อมกัน จะมีคนเดียวที่ได้**

Phase นี้จบที่ booking ที่รอชำระเงิน — ยังไม่แตะ Stripe, ตั๋ว, หรือ admin

## หลักการออกแบบข้อเดียวที่สำคัญที่สุด

**Postgres เป็นผู้ตัดสินสุดท้าย Redis เป็นแค่ด่านแรก**

ระบบจองที่นั่งพังบ่อยที่สุดตรงที่เก็บสถานะไว้ 2 ที่แล้วไม่ตรงกัน ดีไซน์นี้เลยแบ่งหน้าที่ชัด:

| ชั้น | หน้าที่ | ถ้าชั้นนี้พัง |
|---|---|---|
| Redis | กันคนอื่นเริ่มจองที่นั่งเดียวกัน ให้ตอบ 409 เร็วโดยไม่ต้องแตะ DB | ระบบยังถูกต้อง แค่ช้าลงและ error message แย่ลง |
| Postgres row lock (`SELECT ... FOR UPDATE` บน `Seat`) | การันตีว่าที่นั่งหนึ่งผูกกับ booking ที่ยัง active ได้ใบเดียว | จองซ้อนได้จริง — ชั้นนี้ห้ามพัง |

ผลคือ **ถ้า Redis ล่มทั้งตัว ระบบยังจองซ้อนไม่ได้** แค่ช้าลง

## Data model

เพิ่ม 4 ตารางใน `apps/api/prisma/schema.prisma` ต่อจาก 4 ตารางเดิม

```
SeatMap      (id, showtimeId → Showtime, zoneName, price)
Seat         (id, seatMapId → SeatMap, row, number, status)
Booking      (id, userId → User, showtimeId → Showtime, status,
              totalPrice, createdAt, expiresAt)
BookingSeat  (id, bookingId → Booking, seatId → Seat)
```

enum ใหม่:
- `SeatStatus`: `AVAILABLE | BOOKED` — **ไม่มี `HELD`** โดยตั้งใจ (เหตุผลด้านล่าง)
- `BookingStatus`: `PENDING_PAYMENT | PAID | EXPIRED | CANCELLED`

### ทำไม `Seat.status` ไม่มี `HELD`

hold เป็นสถานะชั่วคราวที่มีอายุ 5 นาที ถ้าเก็บใน Postgres ด้วยจะกลายเป็นแหล่งความจริงที่ 2 ที่ต้อง sync กับ Redis ตลอดเวลา และเมื่อ process ตายกลางทางจะเหลือแถวที่ค้างเป็น `HELD` ตลอดกาลโดยไม่มี TTL มาเก็บกวาด

hold จึงอยู่ใน Redis ที่เดียว โดยมี TTL เป็นตัวทำความสะอาดให้อัตโนมัติ ส่วน Postgres เก็บเฉพาะสถานะถาวร (`BOOKED`) ที่ไม่มีวันหมดอายุเอง

### กลไกกันซ้อนใน Postgres: row lock บน `Seat`

ทางที่เลือกคือ **`SELECT ... FOR UPDATE` บนแถว `Seat` ภายในทรานแซกชันเดียว** ไม่ใช่ partial unique index

เหตุผลที่ไม่ใช้ partial index: เงื่อนไขที่ต้องการคือ "ที่นั่งนี้ผูกกับ booking ที่ยัง active อยู่หรือเปล่า" ซึ่งสถานะ active อยู่คนละตาราง (`Booking.status`) และ Postgres **ไม่อนุญาตให้ใช้ subquery ใน predicate ของ partial index** จะทำให้ได้ต้อง denormalize สถานะลงมาที่ `BookingSeat` ซึ่งสร้างข้อมูลซ้ำที่ต้อง sync อีกจุด — กลับไปเจอปัญหาเดิมที่ดีไซน์นี้พยายามเลี่ยง

`SELECT FOR UPDATE` แก้ปัญหาตรงกว่า เพราะ `Seat.status` เป็นแหล่งความจริงอยู่แล้ว:

```sql
BEGIN;
  SELECT id, status FROM "Seat" WHERE id = ANY($1) FOR UPDATE;
  -- ทรานแซกชันอื่นที่ขอที่นั่งชุดนี้จะถูกบล็อกตรงนี้จนกว่าเราจะ COMMIT
  -- ถ้ามีที่ใด status <> 'AVAILABLE' → ROLLBACK แล้วตอบ 409
  UPDATE "Seat" SET status = 'BOOKED' WHERE id = ANY($1);
  INSERT INTO "Booking" ...;
  INSERT INTO "BookingSeat" ...;
COMMIT;
```

คนที่สองจะถูกบล็อกที่บรรทัด `FOR UPDATE` จนคนแรก commit เสร็จ แล้วอ่านเจอ `status = 'BOOKED'` จึงถูกปฏิเสธ — **ไม่มีช่องให้แทรก** ต่างจากการอ่านแล้วค่อยเขียนแบบไม่ล็อก ซึ่งเป็น check-then-act race แบบเดียวกับที่เจอใน rate limiter ของ Phase 1

**สำคัญ:** ต้อง `ORDER BY id` ตอน `SELECT FOR UPDATE` เสมอ เพื่อให้ทุกทรานแซกชันล็อกแถวตามลำดับเดียวกัน มิฉะนั้นสองคนที่เลือกที่นั่งชุดเดียวกันแต่คนละลำดับจะ deadlock กัน

ข้อกำหนดที่ห้ามต่อรอง: ต้องมี test ที่ยิงพร้อมกันจริงแล้วพิสูจน์ได้ว่าเหลือ booking เดียว

## Flow

### จองที่นั่ง

```
POST /showtimes/:showtimeId/seats/hold   { seatIds: string[] }
Authorization: httpOnly cookie (ต้องล็อกอิน)

1. auth middleware ตรวจ JWT จาก cookie → ได้ userId
2. validate: seatIds ไม่ว่าง, ไม่ซ้ำกันเอง, จำนวนไม่เกินเพดานต่อ booking
3. Redis: SET NX hold:seat:{seatId} = userId EX 300  ทีละที่ ตามลำดับ
   ├─ ติดครบทุกที่  → ไปข้อ 4
   └─ มีที่ใดพลาด  → คืน (DEL) ทุกที่ที่เพิ่งล็อกสำเร็จในรอบนี้ → 409
4. Postgres transaction เดียว:
   ├─ SELECT ... FOR UPDATE บนแถว Seat (ORDER BY id กัน deadlock)
   ├─ ตรวจว่าทุกที่ status = AVAILABLE และอยู่ใน showtime นี้จริง
   ├─ คำนวณ totalPrice จาก SeatMap.price (ห้ามเชื่อราคาจาก client)
   ├─ UPDATE Seat SET status = 'BOOKED'
   ├─ สร้าง Booking(PENDING_PAYMENT, expiresAt = now + 5 นาที)
   └─ สร้าง BookingSeat ทุกแถว
   ถ้ามีที่ใดไม่ AVAILABLE → rollback → คืน Redis lock → 409
5. ตอบ 201 { bookingId, expiresAt, totalPrice, seats }
```

**จุดที่ต้องเขียนให้ถูกและมี test คุม:** ข้อ 3 กรณีล็อกได้บางส่วน ถ้าไม่คืน lock ที่ได้มาแล้ว ที่นั่งเหล่านั้นจะค้าง 5 นาทีโดยไม่มีใครจองได้ — เป็นบั๊กที่ผู้ใช้เห็นเป็น "ที่นั่งว่างแต่กดไม่ได้"

### หมดเวลา

Redis key หายเองด้วย TTL แต่แถว `Booking` ใน Postgres ไม่หายเอง จึงต้องมีตัวเก็บกวาด:

```
expireStaleBookings()  ใน apps/api/src/lib/booking.ts   — ทรานแซกชันเดียว
→ หา Booking ที่ status = 'PENDING_PAYMENT' AND expiresAt < now()
→ UPDATE Seat SET status = 'AVAILABLE'
    WHERE id IN (ที่นั่งของ booking เหล่านั้น)   ← ต้องคืนที่นั่งด้วย
→ UPDATE Booking SET status = 'EXPIRED'
```

ทั้งสอง `UPDATE` ต้องอยู่ในทรานแซกชันเดียวกัน มิฉะนั้นจะเกิดสถานะครึ่งๆ กลางๆ ที่ booking หมดอายุแล้วแต่ที่นั่งยังค้าง `BOOKED` ตลอดกาล

เรียกจาก 2 ที่: ตอนต้นของ `getSeatMap` (ที่นั่งจะได้แสดงผลถูกต้องทันทีที่มีคนเปิดดู) และตอนต้นของ hold

> **ponytail:** เก็บกวาดแบบ lazy ตอนมีคนเรียก แทนที่จะตั้ง cron/worker แยก — พอสำหรับ traffic ระดับนี้และไม่ต้องเพิ่ม process ถ้าวันหนึ่งต้องการให้ที่นั่งคืนตรงเวลาแม้ไม่มีคนเปิดดู ค่อยเปลี่ยนเป็น scheduled job

### ดูผังที่นั่ง

```
GET /showtimes/:showtimeId/seats
→ 200 { zones: [{ zoneName, price, seats: [{ id, row, number, status }] }] }
```

`status` ที่ตอบกลับ = `AVAILABLE | HELD | BOOKED` โดย `HELD` คำนวณตอนตอบจากการอ่าน Redis (`MGET` ทีเดียวทั้งรอบ) ไม่ได้เก็บใน DB — endpoint นี้ไม่ต้องล็อกอิน เพราะแค่ดูผัง

### ดูสถานะ booking

```
GET /bookings/:id      ต้องล็อกอิน และต้องเป็นเจ้าของ booking นั้น (ไม่ใช่ → 404 ไม่ใช่ 403)
→ 200 { booking: { id, status, totalPrice, expiresAt, showtime, seats } }
```

ตอบ 404 แทน 403 เมื่อไม่ใช่เจ้าของ เพื่อไม่ให้เดาได้ว่า booking id ไหนมีอยู่จริง (เหตุผลเดียวกับที่ login ตอบข้อความเดียวกันทั้งกรณีอีเมลผิดและรหัสผิด)

## ไฟล์ที่จะสร้าง/แก้

```
apps/api/
  src/middleware/auth.ts        [ใหม่] verify JWT จาก cookie → req.user
  src/lib/seat-lock.ts          [ใหม่] Redis: acquire/release/read hold
  src/lib/redis.ts              [ใหม่] client singleton อ่านจาก REDIS_URL
  src/lib/booking.ts            [ใหม่] createBooking, expireStaleBookings, getBookingForUser
  src/lib/seats.ts              [ใหม่] getSeatMap (รวมสถานะจาก Redis)
  src/lib/config.ts             [แก้] SEAT_HOLD_TTL_SECONDS, MAX_SEATS_PER_BOOKING
  src/routes/showtimes.ts       [ใหม่] GET seats, POST seats/hold
  src/routes/bookings.ts        [ใหม่] GET /bookings/:id
  src/index.ts                  [แก้] mount 2 router ใหม่
  prisma/schema.prisma          [แก้] 4 model + 2 enum
  prisma/seed.ts                [แก้] สร้าง SeatMap 3 โซน 90 ที่ต่อรอบ

apps/web/
  app/showtimes/[id]/seats/page.tsx   [ใหม่] ผังที่นั่ง เลือกแล้วกดจอง
  app/bookings/[id]/page.tsx          [ใหม่] สถานะ + นับถอยหลัง

docker-compose.yml              [แก้] เพิ่ม service redis
tests/unit/api/                 [ใหม่] seat-lock, booking, auth middleware
tests/integration/              [ใหม่] concurrency test ยิงพร้อมกันจริง
```

## ค่าคงที่ (อยู่ใน `lib/config.ts` ที่เดียว)

| ค่า | ค่าที่ใช้ | เหตุผล |
|---|---|---|
| `SEAT_HOLD_TTL_SECONDS` | 300 (5 นาที) | ตามที่ระบุใน `CLAUDE.md` — พอให้กรอกบัตรเสร็จ แต่ไม่นานจนที่นั่งถูกกักโดยคนที่เปลี่ยนใจ |
| `MAX_SEATS_PER_BOOKING` | 8 | กันคนกดกวาดทั้งโซนในคำสั่งเดียว |

ราคาอ่านจาก `SeatMap.price` ใน DB เสมอ **ห้ามรับราคาจาก client** และห้าม hardcode ในโค้ด

## ผังที่นั่ง (seed)

3 โซนต่อรอบ โซนละ 5 แถว แถวละ 6 ที่ = 90 ที่

| โซน | ราคา (บาท) |
|---|---|
| VIP | 3,500 |
| ธรรมดา | 2,000 |
| ยืน | 1,200 |

## การทดสอบ

### Unit test (Vitest, mock Redis + Prisma)
1. hold ที่นั่งว่างทั้งหมด → สร้าง booking สำเร็จ
2. hold ที่นั่งที่คนอื่นถืออยู่ → 409 และ**ไม่**สร้าง booking
3. **hold 3 ที่ ติด 2 พลาดที่ 3 → ต้องเรียก DEL คืนทั้ง 2 ที่ที่ล็อกสำเร็จ** (test นี้ต้อง fail ได้จริงถ้าลืมคืน)
4. hold ที่นั่งที่ `status = BOOKED` แล้ว → 409
5. hold โดยไม่ล็อกอิน → 401
6. hold เกิน `MAX_SEATS_PER_BOOKING` → 400
7. `expireStaleBookings` เปลี่ยนเฉพาะ booking ที่หมดเวลาจริง ไม่แตะใบที่ยังไม่หมด **และคืน `Seat.status` กลับเป็น `AVAILABLE`** (ถ้าลืมคืนที่นั่ง test นี้ต้อง fail)
8. `GET /bookings/:id` ของคนอื่น → 404
9. `totalPrice` คำนวณจาก DB ไม่ใช่จาก client (ส่งราคาปลอมมาแล้วต้องไม่มีผล)

### Concurrency test (ยิง API จริง ไม่ mock)
ต้องมี Postgres + Redis จริงรันอยู่ ยิง `POST /seats/hold` ที่นั่งเดียวกัน **20 requests พร้อมกันด้วย `Promise.all`** แล้ว assert:
- ตอบ 201 **หนึ่งเดียว** ที่เหลือเป็น 409
- ในฐานข้อมูลมีแถว `BookingSeat` ของที่นั่งนั้น **แถวเดียว**

การยิงแบบ sequential ผ่านได้แม้โค้ดมี race condition — บทเรียนจาก rate limiter ของ Phase 1 ที่ผ่าน test แบบ sequential ทั้งที่ยิงขนาน 200 requests ทะลุหมด **test นี้ต้องยิงขนานจริงเท่านั้น**

### ยังไม่ทำใน Phase นี้
Playwright e2e — เลื่อนไปทำพร้อม Phase 3 (ตอนมี flow จ่ายเงินครบแล้ว e2e จะคุ้มค่ากว่า) concurrency test ครอบข้อที่โจทย์วัดจริงอยู่แล้ว

## สิ่งที่ Phase นี้จงใจไม่ทำ

- ชำระเงิน (Phase 3) — booking จบที่ `PENDING_PAYMENT`
- ออกตั๋ว/QR (Phase 4)
- หน้า admin (Phase 5)
- ผังที่นั่งแบบ real-time push (WebSocket) — ใช้การโหลดใหม่ตอนเปิดหน้าพอ
- แก้ไข/ยกเลิก booking โดยผู้ใช้เอง
- ที่นั่งติดกัน (seat adjacency) หรือแนะนำที่นั่งอัตโนมัติ

## ความเสี่ยงที่รู้ตัว

| ความเสี่ยง | รับมืออย่างไร |
|---|---|
| Redis ล่ม | Postgres constraint ยังกันซ้อนได้ ระบบช้าลงแต่ไม่ผิด |
| Process ตายหลังล็อก Redis แต่ก่อนเขียน DB | TTL 5 นาทีคืนที่นั่งเอง |
| Booking ค้าง `PENDING_PAYMENT` ตลอดกาล | `expireStaleBookings` เรียกแบบ lazy ตอนมีคนดูผัง |
| ผู้ใช้เปิด 2 แท็บจองที่นั่งเดียวกันเอง | Redis เก็บ `userId` เป็นค่า จึงแยกได้ว่าเป็นเจ้าของเดิม — ตัดสินใจว่า**ปฏิเสธ**เหมือนคนอื่น เพื่อความเรียบง่าย และบันทึกไว้ว่าถ้า UX แย่ค่อยเปลี่ยน |
