# Phase 3 — ชำระเงิน (mock provider)

**สถานะ:** อนุมัติแล้ว 11 ส.ค. 2026 · ต่อจาก Phase 2 (เลือกที่นั่ง + จอง) ที่เสร็จแล้ว

## เป้าหมาย

ให้ booking สถานะ `PENDING_PAYMENT` เดินต่อไปจนเป็น `PAID` ผ่านการชำระเงิน โดย**ไม่ต้องมีเงินจริงและไม่ต้องสมัครบริการภายนอก** แต่ยังคงโครงสร้างของจริงไว้ครบ: checkout session, webhook, การตรวจลายเซ็น, idempotency และการอัพเดตสถานะแบบ transaction เดียว

## การตัดสินใจของคนที่กำหนดขอบเขตนี้

1. **ใช้ mock provider ที่เราเขียนเอง ไม่ใช่ Stripe** — `CLAUDE.md` ข้อ 2 ระบุ Stripe และข้อ 5 ห้าม agent เปลี่ยน payment provider เอง การเปลี่ยนครั้งนี้จึงเป็นการตัดสินใจของคน บันทึกไว้ที่นี่ ทั้งนี้ **โครงสร้างโค้ดต้องเปลี่ยนไปใช้ Stripe ได้ภายหลังโดยแก้เฉพาะชั้น provider** ไม่แตะ logic การจอง
2. **webhook ที่มาถึงช้ากว่าเวลา hold: กู้ booking กลับถ้าที่นั่งยังว่าง ถ้าไม่ว่างให้ mark `REFUND_REQUIRED`** — เงินถูกตัดไปแล้ว จะปฏิเสธเฉยๆ ไม่ได้ การคืนเงินจริงเป็นงาน Phase 5

## หลักการที่ยึด

**Postgres เป็นผู้ตัดสินเหมือนเดิม** Phase 2 พิสูจน์แล้วว่า `SELECT ... FOR UPDATE` คือสิ่งที่กันที่นั่งซ้อน Phase 3 ไม่เปลี่ยนหลักนี้ — การกู้ booking ที่หมดเวลาก็ต้องล็อกแถวที่นั่งด้วยวิธีเดียวกัน

**mock ต้องไม่ทำให้ทางเดินสั้นลง** ปุ่ม "จ่ายสำเร็จ" ไม่ได้เรียกฟังก์ชันภายในตรงๆ แต่ยิง HTTP POST จริงไปที่ webhook พร้อมลายเซ็น เพื่อให้ handler ถูกทดสอบเหมือนตอน provider จริงยิงมา ถ้า mock เรียกฟังก์ชันตรง เราจะไม่มีวันรู้ว่าการตรวจลายเซ็นหรือการอ่าน raw body พังหรือเปล่า

## Data model

```prisma
enum PaymentStatus {
  PENDING
  SUCCEEDED
  FAILED
}

model Payment {
  id          String        @id @default(cuid())
  bookingId   String        @unique
  booking     Booking       @relation(fields: [bookingId], references: [id])
  provider    String                        // 'mock' วันนี้, 'stripe' วันหน้า
  providerRef String        @unique         // session id ฝั่ง provider
  amount      Int                           // บาทเต็มจำนวน ห้ามเป็น Float
  status      PaymentStatus @default(PENDING)
  paidAt      DateTime?
  createdAt   DateTime      @default(now())
}

model WebhookEvent {
  id         String   @id @default(cuid())
  eventId    String   @unique
  receivedAt DateTime @default(now())
}
```

`BookingStatus` เพิ่มค่า `REFUND_REQUIRED`

`Booking` เพิ่ม back-relation `payment Payment?`

### `WebhookEvent.eventId` คือกลไก idempotency ทั้งหมด

Provider ทุกเจ้ายิง webhook ซ้ำได้ (timeout แล้ว retry, at-least-once delivery) ถ้าไม่กัน จะออกตั๋วซ้ำหรือหักเงินซ้ำ

วิธีที่ใช้: **INSERT แถว `WebhookEvent` ใน transaction เดียวกับที่อัพเดตสถานะ** ถ้าชน unique constraint (Prisma `P2002`) แปลว่าเคยประมวลผล event นี้ไปแล้ว ให้ rollback แล้วตอบ `200` ทันที

เหตุผลที่ INSERT ก่อนแทนที่จะ SELECT ก่อน: การ SELECT-แล้วค่อย-INSERT เป็น check-then-act race แบบเดียวกับที่ Phase 2 เจอมาแล้วสองครั้ง — webhook สองตัวที่มาถึงพร้อมกันจะ SELECT ไม่เจอทั้งคู่ แล้วทำงานซ้อนกัน unique constraint คือสิ่งเดียวที่กันได้จริงเมื่อยิงขนาน

## Flow

### สร้าง checkout session

```
POST /bookings/:id/checkout          ต้อง login และเป็นเจ้าของ booking
```

1. โหลด booking ของผู้ใช้คนนี้ (ไม่ใช่เจ้าของ → `404` เหมือนเดิม)
2. สถานะต้องเป็น `PENDING_PAYMENT` และยังไม่หมดเวลา ไม่งั้น `409`
3. ถ้ามี `Payment` อยู่แล้วและยัง `PENDING` → คืน session เดิม (กดปุ่มซ้ำต้องไม่สร้าง session ใหม่)
4. สร้าง `Payment(PENDING)` โดย `amount` อ่านจาก `booking.totalPrice` **ห้ามรับจาก client**
5. ตอบ `201 { checkoutUrl, providerRef, amount }`

### หน้าจ่ายเงินจำลอง

`apps/web` หน้า `/mock-pay/[providerRef]` แสดงยอดเงินและปุ่มสองปุ่ม: จ่ายสำเร็จ / จ่ายไม่สำเร็จ

หน้านี้แทนที่หน้า Checkout ของ provider จริง จึง**ไม่ต้องล็อกอิน** (provider จริงก็ไม่รู้จัก session ของเรา) แต่มันแสดงแค่ยอดเงิน ไม่แสดงข้อมูลส่วนตัวใดๆ

### กดปุ่ม → provider ยิง webhook

```
POST /mock-provider/sessions/:providerRef/complete   { outcome: 'succeeded' | 'failed' }
```

endpoint นี้คือ **ตัว provider จำลอง** ไม่ใช่ส่วนหนึ่งของระบบจอง

> ⚠️ **ต้องปิดตายใน production** endpoint นี้ทำให้ booking กลายเป็น `PAID` ได้โดยไม่มีเงินจริง ถ้าหลุดขึ้น production ใครก็ได้ตั๋วฟรี จึงต้อง:
> - mount router นี้ **เฉพาะเมื่อ** `PAYMENT_PROVIDER === 'mock'` เท่านั้น ไม่ใช่ mount แล้วค่อยเช็คข้างใน
> - `config.ts` ต้อง `throw` ตอนสตาร์ทถ้า `NODE_ENV === 'production'` และ `PAYMENT_PROVIDER === 'mock'` — ให้ deploy พังดังๆ ดีกว่าเปิดช่องเงียบๆ
> - มี test ยืนยันว่าเมื่อ provider ไม่ใช่ mock แล้ว route นี้ตอบ 404

มันจะ:

1. ประกอบ payload `{ eventId, providerRef, outcome, amount }` โดย `eventId` สุ่มใหม่ทุกครั้ง
2. เซ็นด้วย `HMAC-SHA256(rawBody, PAYMENT_WEBHOOK_SECRET)` ด้วย `node:crypto` ไม่ต้องเพิ่ม dependency
3. `fetch` POST ไปที่ `/webhooks/payment` ของเราเอง พร้อม header `x-payment-signature`

> **ponytail:** provider จำลองอยู่ใน process เดียวกับ API — ประหยัดกว่าตั้ง service แยกและเพียงพอสำหรับการสาธิต ถ้าวันหนึ่งต้องจำลอง provider ที่ช้าหรือล่ม ค่อยแยกออกไป

### Webhook

```
POST /webhooks/payment      ไม่ต้องล็อกอิน แต่ต้องมีลายเซ็นถูกต้อง
```

1. **ตรวจลายเซ็นจาก raw body** ผิดหรือไม่มี → `400` และ**ไม่แตะฐานข้อมูลเลย**
2. parse payload ด้วย zod
3. transaction เดียว:
   - INSERT `WebhookEvent(eventId)` — ชน `P2002` → rollback, ตอบ `200` (เคยทำแล้ว)
   - `outcome: 'failed'` → `Payment` เป็น `FAILED` และ**ไม่แตะ booking เลย** ไม่ว่าตอนนั้นจะเป็น `PENDING_PAYMENT` (จ่ายใหม่ได้จนกว่าจะหมดเวลา) หรือ `EXPIRED` ไปแล้ว การจ่ายไม่สำเร็จไม่ควรเปลี่ยนสถานะการจองในทิศทางใดทั้งสิ้น
   - `outcome: 'succeeded'` → ดูสถานะ booking:
     - `PENDING_PAYMENT` → `Payment.SUCCEEDED` + `paidAt`, booking → `PAID`
     - `PAID` อยู่แล้ว → ไม่ทำอะไร (idempotent ซ้อนอีกชั้น)
     - `EXPIRED` → **ลองกู้** (ด้านล่าง)
4. ตอบ `200` เสมอเมื่อลายเซ็นถูก แม้จะไม่ได้ทำอะไร — provider จริงจะ retry ถ้าได้ non-2xx

### การกู้ booking ที่หมดเวลา

ภายใน transaction เดียวกัน:

```sql
SELECT s.id, s.status FROM "Seat" s
WHERE s.id = ANY(<seat ids ของ booking นี้>)
ORDER BY s.id
FOR UPDATE
```

- ทุกที่นั่ง `AVAILABLE` → `UPDATE Seat SET status='BOOKED'`, booking → `PAID`, payment → `SUCCEEDED`
- มีที่ใดไม่ว่าง → **ไม่แตะที่นั่งเลย**, booking → `REFUND_REQUIRED`, payment → `SUCCEEDED` (เงินเข้าจริง)

`ORDER BY s.id` ด้วยเหตุผลเดิม: ล็อกตามลำดับเดียวกันเสมอ ไม่งั้น deadlock กับ `createBooking`

## ไฟล์ที่จะสร้าง/แก้

```
apps/api/
  prisma/schema.prisma            [แก้] Payment, WebhookEvent, REFUND_REQUIRED
  src/lib/config.ts               [แก้] PAYMENT_WEBHOOK_SECRET, PAYMENT_PROVIDER, API_BASE_URL
  src/lib/payment.ts              [ใหม่] createCheckoutSession, applyPaymentOutcome
  src/lib/webhook-signature.ts    [ใหม่] sign / verify ด้วย node:crypto (timingSafeEqual)
  src/routes/bookings.ts          [แก้] POST /:id/checkout
  src/routes/webhooks.ts          [ใหม่] POST /payment
  src/routes/mock-provider.ts     [ใหม่] POST /sessions/:ref/complete
  src/index.ts                    [แก้] express.raw เฉพาะ webhook ก่อน express.json

apps/web/
  app/mock-pay/[ref]/page.tsx     [ใหม่] หน้าจ่ายเงินจำลอง
  app/bookings/[id]/page.tsx      [แก้] ปุ่มไปชำระเงิน + แสดงสถานะใหม่

tests/unit/api/                   payment, webhook-signature
tests/integration/                webhook ยิงซ้ำ + ยิงขนาน
```

## จุดที่พังง่ายและต้องระวัง

### raw body

`express.json()` อ่านสตรีมจนหมดแล้วทิ้ง buffer เดิม ถ้าคำนวณ HMAC จาก `JSON.stringify(req.body)` ลายเซ็นจะไม่ตรงเมื่อ provider จัดเรียง key หรือเว้นวรรคต่างไปแม้แต่นิดเดียว

วิธีแก้: mount `express.raw({ type: 'application/json' })` **เฉพาะ path `/webhooks`** และ **ก่อน** `app.use(express.json())` แล้วคำนวณ HMAC จาก `req.body` ที่เป็น `Buffer` ตรงๆ

### เปรียบเทียบลายเซ็นต้องใช้ `timingSafeEqual`

`===` บนสตริงจะคืนค่าเร็วขึ้นเมื่อไบต์แรกไม่ตรง ทำให้เดาลายเซ็นทีละไบต์ได้ ใช้ `crypto.timingSafeEqual` และเช็คความยาวก่อน (มันโยน error ถ้าความยาวไม่เท่ากัน)

### `CLAUDE.md` ข้อ 5

ห้ามปิดหรือข้ามการตรวจลายเซ็นไม่ว่ากรณีใด รวมถึง "ชั่วคราวเพื่อ debug" จะมี test ที่ยิง payload ปลอมและ payload ที่ถูกแก้ไขหลังเซ็น แล้วต้องถูกปฏิเสธทั้งคู่

## การทดสอบ

### Unit
1. ลายเซ็นถูก → verify ผ่าน
2. ลายเซ็นผิด → ไม่ผ่าน
3. payload ถูกแก้หลังเซ็นแม้ 1 ตัวอักษร → ไม่ผ่าน
4. ไม่มี header ลายเซ็น → `400` และไม่แตะ DB
5. `createCheckoutSession` กับ booking ที่ไม่ใช่ของตัวเอง → ไม่สำเร็จ
6. `createCheckoutSession` กดซ้ำ → ได้ session เดิม ไม่สร้างใหม่
7. `amount` มาจาก `booking.totalPrice` เสมอ ส่งค่าปลอมมาไม่มีผล
8. จ่ายสำเร็จ → booking `PAID`, payment `SUCCEEDED`, `paidAt` ถูกตั้ง
9. จ่ายไม่สำเร็จ → payment `FAILED`, booking ยัง `PENDING_PAYMENT`
10. หมดเวลา + ที่นั่งว่าง → กู้กลับเป็น `PAID`
11. หมดเวลา + ที่นั่งไม่ว่าง → `REFUND_REQUIRED` และ**ไม่แตะที่นั่ง**

### Integration (ต้องมี Postgres จริง)
12. ยิง webhook เดิมซ้ำ 2 ครั้งติด → booking `PAID` ครั้งเดียว มี `Payment` แถวเดียว `WebhookEvent` แถวเดียว
13. **ยิง webhook เดิมพร้อมกัน 10 ครั้งด้วย `Promise.all`** → ผลเหมือนยิงครั้งเดียว

ข้อ 13 สำคัญกว่าข้อ 12 เพราะการยิงทีละครั้งผ่านได้แม้โค้ดมี check-then-act race — บทเรียนซ้ำจาก Phase 1 (rate limiter) และ Phase 2 (concurrency test ที่พิสูจน์ผิดชั้น)

## สิ่งที่จงใจไม่ทำใน Phase นี้

- คืนเงินจริง (Phase 5) — `REFUND_REQUIRED` เป็นแค่ธง ยังไม่มีปุ่มคืนเงิน
- ออกตั๋ว/QR (Phase 4)
- ส่งอีเมลใบเสร็จ (Phase 4)
- Stripe จริง — แต่โครงสร้างต้องรองรับการสลับ
- หน้าจัดการของ admin (Phase 5)
- จ่ายบางส่วน ผ่อนชำระ หรือคูปองส่วนลด

## ความเสี่ยงที่รู้ตัว

| ความเสี่ยง | รับมืออย่างไร |
|---|---|
| webhook ยิงซ้ำ | unique constraint บน `eventId` insert ใน transaction เดียวกับผลลัพธ์ |
| webhook มาช้ากว่า hold | กู้ถ้าที่นั่งว่าง ไม่งั้น `REFUND_REQUIRED` ให้คนตามเก็บ |
| ลายเซ็นถูกปลอม | HMAC-SHA256 + `timingSafeEqual` จาก raw body |
| กดปุ่มจ่ายเงินซ้ำ | คืน session เดิมเมื่อ payment ยัง `PENDING` |
| `REFUND_REQUIRED` ไม่มีใครตามเก็บ | เป็นข้อจำกัดที่รู้ตัว — Phase 5 ต้องมีหน้า admin ที่กรองสถานะนี้ บันทึกไว้เป็น `// LIMITATION:` ในโค้ด |
