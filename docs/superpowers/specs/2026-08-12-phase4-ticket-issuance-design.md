# Phase 4 — ออกตั๋ว + แจ้งเตือน

**สถานะ:** อนุมัติแล้ว 12 ส.ค. 2026 · ต่อจาก Phase 3 (ชำระเงินผ่าน mock provider) ที่ merge เข้า `main` แล้วที่ `004bbe3`

## เป้าหมาย

booking ที่จ่ายเงินสำเร็จ (`PAID`) ต้องได้ตั๋วที่ผู้ใช้เปิดดูได้จริงพร้อม QR code และได้อีเมลยืนยัน ปิดข้อกำหนดข้อที่ 4 จาก 5 ข้อของโจทย์ (ออกตั๋ว) เหลือแค่ admin panel เป็น Phase 5

## การตัดสินใจของคนที่กำหนดขอบเขตนี้

1. **QR payload เป็น `<ticketId>.<hmac>` ไม่ใช่ random token ที่ต้อง lookup** — ตรวจได้โดยไม่แตะ DB และปลอมไม่ได้ถ้าไม่มี secret
2. **ออกตั๋วใน transaction เดียวกับตอน booking กลายเป็น `PAID`** ไม่ใช่ตอนเปิดหน้าตั๋วครั้งแรก — `PAID` แล้วต้องมีตั๋วเสมอ ไม่มี state ค้างครึ่งกลาง ตรงกับ checklist Phase 3 ข้อ 2
3. **อีเมลยิง Resend REST ด้วย `fetch` ไม่เพิ่ม npm dependency** — `CLAUDE.md` ข้อ 2 ห้ามเพิ่ม dep ที่ยังไม่จำเป็น SDK ของ Resend ทำสิ่งที่ `fetch` 10 บรรทัดทำได้ ยังไม่มี `RESEND_API_KEY` ตอนนี้ จึงต้อง degrade เป็น log แทนที่จะพัง

## หลักการที่ยึด

**unique constraint เป็นผู้ตัดสิน ไม่ใช่การอ่านก่อนเขียน** เหมือน `WebhookEvent.eventId` ของ Phase 3 — `Ticket.bookingId @unique` คือสิ่งเดียวที่กันตั๋วซ้ำได้จริงเมื่อ webhook ยิงขนานกัน การ `findFirst` ก่อน `create` เป็น check-then-act race แบบเดียวกับที่โปรเจกต์นี้เจอมาทุก phase

**อีเมลอยู่นอก transaction และล้มเหลวได้โดยไม่ทำให้ webhook พัง** ถ้า transaction ต้องรอ HTTP call ไปหา Resend จะถือ lock ที่นั่งไว้นานเกินจำเป็น และถ้าอีเมลพังแล้ว webhook ตอบ 500 provider จะยิงซ้ำ — ตั๋วออกไปแล้ว เงินตัดไปแล้ว แต่ผู้ใช้จะเห็น flow ค้าง

## Data model

เพิ่มตารางเดียว ไม่แก้ตารางเดิม (additive ล้วน)

```prisma
model Ticket {
  id            String   @id @default(cuid())
  bookingId     String   @unique
  booking       Booking  @relation(fields: [bookingId], references: [id])
  qrCodePayload String
  issuedAt      DateTime @default(now())
}
```

`Booking` เพิ่ม back-relation `ticket Ticket?`

**ทำไมไม่ทำ `Ticket` ต่อที่นั่ง** 1 booking = 1 ตั๋วที่มีหลายที่นั่งอยู่ข้างใน ตามที่แผนงานข้อ 5 ระบุ (`Booking 1—1 Ticket`) ถ้าวันหน้าต้องแยกตั๋วรายที่นั่งค่อยเพิ่ม ไม่ต้องเดาวันนี้

**`qrCodePayload` เก็บลง DB ทั้งที่คำนวณใหม่ได้** เพราะถ้าวันหน้าเปลี่ยน secret ตั๋วที่ออกไปแล้วต้องยังอ่านออก การเก็บค่าที่ออกไปแล้วไว้ทำให้ debug ได้ว่าใบไหนเซ็นด้วยอะไร

## QR payload

รูปแบบ: `<ticketId>.<hmac-sha256 hex 64 ตัว>`

เซ็นด้วย `TICKET_SIGNING_SECRET` **แยกจาก `PAYMENT_WEBHOOK_SECRET`** — คนละ trust boundary ถ้า secret ของ webhook หลุด คนที่ได้ไปต้องปลอมตั๋วไม่ได้ และกลับกัน

`lib/ticket.ts` มี 2 ฟังก์ชัน:

```ts
export function signTicketPayload(ticketId: string): string
export function verifyTicketPayload(payload: string): string | null   // คืน ticketId ถ้าผ่าน, null ถ้าไม่
```

`verifyTicketPayload` ต้องเดินตามบทเรียนของ `webhook-signature.ts` ทุกข้อ เพราะเป็นบั๊กเดียวกันคนละที่:
- ตรวจ `/^[0-9a-f]{64}$/i` ก่อน decode — `Buffer.from(hex)` หยุด decode ที่คู่แรกที่ผิดแทนที่จะ throw ลายเซ็นถูก 64 ตัวแล้วต่อขยะท้ายจึงผ่านได้ถ้าไม่ตรวจ
- เทียบด้วย `timingSafeEqual` ไม่ใช่ `===`
- เช็คความยาว buffer ให้เท่ากันก่อนเรียก `timingSafeEqual`

**LIMITATION: ยังไม่มี endpoint สแกนตั๋ว** เพราะยังไม่มีแอปสแกนที่จะเรียกมัน (YAGNI) `verifyTicketPayload` มี test ครอบไว้แล้ว วันที่มีเครื่องสแกนจริงค่อยเพิ่ม `POST /tickets/verify` ที่เรียกฟังก์ชันเดิมนี้ ไม่ต้องเขียน logic ใหม่ และตอนนั้นต้องคิดเรื่อง "ตั๋วใบนี้ถูกใช้ไปแล้วหรือยัง" ซึ่ง payload อย่างเดียวตอบไม่ได้

## การออกตั๋ว

`lib/ticket.ts` เพิ่ม:

```ts
export async function issueTicket(tx: Prisma.TransactionClient, bookingId: string): Promise<void>
```

- `create` แล้วจับ `P2002` แปลว่ามีตั๋วอยู่แล้ว → ไม่ทำอะไร ไม่ throw (webhook ยิงซ้ำต้องได้ผลเดิม)
- `qrCodePayload` เซ็นจาก id ที่ generate เอง ไม่ใช่ปล่อยให้ `@default(cuid())` สร้าง เพราะต้องรู้ id ก่อนถึงจะเซ็นได้ — ใช้ `randomUUID()` จาก `node:crypto` (ตัวเดียวกับที่ `payment.ts` ใช้อยู่แล้ว) แล้วส่ง `id` เข้า `create` พร้อม `qrCodePayload`

`applyPaymentOutcome()` ใน `lib/payment.ts` มี **2 จุด** ที่ booking กลายเป็น `PAID`:
1. CAS ปกติ `PENDING_PAYMENT → PAID` (บรรทัดที่ `won.count === 1`)
2. recover path หลังแพ้ให้ expiry sweep แล้วที่นั่งยังว่างครบ

ทั้งสองจุดเรียก `issueTicket(tx, bookingId)` **ตัวเดียวกัน** ก่อน return ห้ามก็อป logic สร้างตั๋วซ้ำสองที่ตาม `CLAUDE.md` ข้อ 3 §4

จุดที่ **ไม่ออกตั๋ว**: `outcome === 'failed'`, `REFUND_REQUIRED`, duplicate delivery ที่แพ้ `WebhookEvent` constraint, และ CAS ที่ `stamped.count === 0` (แพ้ให้ checkout retry)

## Endpoints

| Method | Path | Auth | ทำอะไร |
|---|---|---|---|
| `GET` | `/me/tickets` | ✅ | ตั๋วทั้งหมดของผู้ใช้ เรียงใหม่→เก่า พร้อมชื่อ event, รอบ, ที่นั่ง |
| `GET` | `/tickets/:id` | ✅ เจ้าของ | ตั๋วใบเดียว + QR เป็น data URL |

**การ guard**: query scope ด้วย `where: { id, booking: { userId } }` ตรงใน query เดียว ไม่ใช่ fetch มาก่อนแล้วเทียบทีหลัง — ไม่ใช่เจ้าของได้ `404` ไม่ใช่ `403` ตามกติกา status code ในแผนงานข้อ 5.1 (403 จะยืนยันว่า id นั้นมีจริง)

booking ที่ยังไม่ `PAID` ไม่มีแถว `Ticket` อยู่แล้ว จึงเข้าหน้าตั๋วไม่ได้โดยธรรมชาติ ไม่ต้องเช็ค `booking.status` ซ้ำ — แต่ test ต้องพิสูจน์ข้อนี้ ไม่ใช่เชื่อเอา

QR data URL สร้างฝั่ง backend ด้วย `qrcode` (`npm i -w apps/api qrcode` + `@types/qrcode` — อยู่ใน stack ที่ `CLAUDE.md` ข้อ 2 อนุมัติไว้แล้ว ไม่ใช่ dep ใหม่ที่ต้องขออนุมัติ) frontend แค่ `<img src>` — ไม่ต้องรู้ว่า payload ข้างในคืออะไร

## อีเมลยืนยัน

`lib/email.ts`:

```ts
export async function sendBookingConfirmation(input: {
  to: string; bookingId: string; eventTitle: string; startTime: Date; seats: string[]; ticketUrl: string
}): Promise<void>
```

- มี `RESEND_API_KEY` → `POST https://api.resend.com/emails` ด้วย `fetch` ธรรมดา
- ไม่มี → `console.info` ว่าจะส่งอะไรไปหาใคร แล้ว return ปกติ (dev ไม่ต้องมี key)
- ไม่ throw ออกไปหา caller ในกรณีปกติ ผู้เรียกยังต้อง `.catch()` กันไว้อีกชั้น

เรียกจาก route ของ webhook **หลัง `applyPaymentOutcome` commit แล้ว** และเฉพาะเมื่อ `bookingStatus === 'PAID'` และ `applied === true` แบบ fire-and-forget:

```ts
void sendBookingConfirmation(...).catch((err) => logServerError('confirmation email failed', err))
```

**LIMITATION: อีเมลที่ส่งไม่สำเร็จหายไปเลย ไม่มี retry** ยอมรับได้เพราะตั๋วอยู่ในหน้า "ตั๋วของฉัน" อยู่แล้ว อีเมลเป็นความสะดวก ไม่ใช่ทางเดียวที่จะได้ตั๋ว ถ้าวันหน้าอีเมลกลายเป็นช่องทางหลัก ต้องมีคิวและ retry ซึ่งแปลว่าต้องเพิ่ม dependency — ต้องถามคนก่อน

**duplicate delivery ไม่ส่งอีเมลซ้ำ** เพราะ `applied === false` เมื่อแพ้ `WebhookEvent` constraint

## หน้าเว็บ

| Path | หน้าอะไร |
|---|---|
| `/me/tickets` | ลิสต์ตั๋วของฉัน ยังไม่มีตั๋วให้ลิงก์ไป `/events` |
| `/me/tickets/[id]` | QR ขนาดใหญ่ + ชื่อ event, รอบ (`toLocaleString('th-TH')` เป็น พ.ศ.), ที่นั่ง, รหัสตั๋ว |

ภาษาไทยทั้งหมด · responsive · `<img alt>` บอกรหัสตั๋วเป็นตัวหนังสือ ไม่สื่อด้วยภาพอย่างเดียวตามข้อกำหนด accessibility ในแผนงานข้อ 5.4 · ไม่มี business logic ฝั่ง frontend เรียก API แล้วแสดงผลเท่านั้น

หลังจ่ายเงินสำเร็จ หน้า `/bookings/[id]/success` เพิ่มลิงก์ไปหน้าตั๋ว

## Config

`lib/config.ts` เพิ่ม (ค่าคงที่ที่เดียวตาม `CLAUDE.md` ข้อ 3):

```ts
export const TICKET_SIGNING_SECRET = process.env.TICKET_SIGNING_SECRET ?? 'dev-ticket-secret-change-me'
export const RESEND_API_KEY = process.env.RESEND_API_KEY
export const EMAIL_FROM = process.env.EMAIL_FROM ?? 'tickets@example.com'
```

`assertPaymentProviderIsSafe()` (หรือ guard คู่กัน) ต้อง throw ตอน boot ถ้า `NODE_ENV === 'production'` แล้ว `TICKET_SIGNING_SECRET` ไม่ได้ตั้ง หรือยังเป็นค่า placeholder ที่ commit ไว้ — บทเรียนเดียวกับ `PAYMENT_WEBHOOK_SECRET` ที่ Phase 3 ต้องกลับไปแก้ทีหลัง

## Test ที่ต้องมี

logic ทุกกิ่งต้องมี test ที่ fail จริงถ้าพัง (`CLAUDE.md` ข้อ 4 §7):

1. `issueTicket` เรียกซ้ำด้วย bookingId เดิม → ได้ตั๋วใบเดิม ไม่ throw ไม่เกิดแถวที่สอง
2. `verifyTicketPayload` — payload ถูกต้องผ่าน · แก้ ticketId แล้ว fail · แก้ hmac แล้ว fail · ต่อขยะท้าย hmac แล้ว fail (เคสที่ Phase 3 เคยพลาดจริง) · ไม่มีจุดคั่น fail
3. `applyPaymentOutcome` outcome `succeeded` → มีแถว `Ticket` · `failed` → ไม่มี · `REFUND_REQUIRED` → ไม่มี
4. ยิง webhook สำเร็จซ้ำสองครั้งด้วย eventId ต่างกัน → ยังมีตั๋วใบเดียว
5. `GET /tickets/:id` ของคนอื่น → `404` · ของตัวเอง → `200` พร้อม QR
6. `sendBookingConfirmation` โยน error → webhook ยังตอบ `200` และตั๋วยังอยู่

## สิ่งที่ตัดออกโดยตั้งใจ

| ตัดอะไร | เพิ่มเมื่อไหร่ |
|---|---|
| endpoint สแกน/ตรวจตั๋ว | มีแอปสแกนจริง — และต้องออกแบบเรื่อง "ใช้ไปแล้ว" พร้อมกัน |
| ตั๋ว PDF / Apple Wallet | มีคนขอ |
| ปุ่มส่งอีเมลซ้ำ | มีคนรายงานว่าอีเมลไม่ถึง |
| retry คิวอีเมล | อีเมลกลายเป็นช่องทางหลัก (ต้องเพิ่ม dependency = ต้องถามคนก่อน) |
| Playwright e2e | ค้างมาตั้งแต่ Phase 2 — ทำรอบเดียวจบหลัง Phase 4 เมื่อ flow จอง→จ่าย→ได้ตั๋ว ครบทั้งเส้น |

## Checklist ตรวจรับ (จากแผนงานข้อ 6)

- [ ] QR สแกนแล้ว decode ได้ค่าที่ตรวจสอบย้อนกลับไป booking จริงได้ — พิสูจน์ด้วย test ข้อ 2 + สแกนด้วยมือถือจริง 1 ครั้ง
- [ ] อีเมลส่งถึงจริงในสภาพแวดล้อม staging — **ยังทำไม่ได้จนกว่าจะมี `RESEND_API_KEY`** ต้องรายงานตรงๆ ว่ายังไม่ได้ยืนยัน ไม่ใช่ทำเหมือนผ่าน
- [ ] ตั๋วที่ยังไม่จ่ายเงินเข้าไม่ถึงหน้าตั๋ว — test ข้อ 5
- [ ] `npm run build` + `npm test` ผ่านทั้งสอง app
