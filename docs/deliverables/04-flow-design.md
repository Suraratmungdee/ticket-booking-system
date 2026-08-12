# 4. Flow Design

## 4.1 ฝั่งผู้ใช้ (happy path)

1. ค้นหา event/รอบ (by วันที่, สถานที่, ประเภท) → เห็นรายการ showtime ที่ว่าง
2. เลือก showtime → เห็นผังที่นั่ง (ที่นั่งว่าง/ถูกจอง/ถูก hold ชั่วคราว)
3. เลือกที่นั่ง → ระบบสร้าง **seat hold** (Redis key, TTL 5 นาที) กันคนอื่นจองซ้ำ
4. สร้าง booking สถานะ `PENDING_PAYMENT` → ไปหน้าชำระเงิน
5. ชำระเงินผ่าน Stripe Checkout
6. Stripe ยิง webhook `checkout.session.completed` → server verify signature → อัพเดต booking เป็น `PAID` → ปลด seat hold เป็น `BOOKED` ถาวร → generate ตั๋ว (QR code ผูกกับ booking id)
7. ผู้ใช้เห็น/ดาวน์โหลดตั๋วในหน้า "ตั๋วของฉัน" + ส่งอีเมลยืนยัน
8. ถ้า hold หมดเวลาก่อนจ่ายเงิน → seat กลับเป็นว่าง, booking เป็น `EXPIRED`

## 4.2 ฝั่ง Admin

- CRUD: event, venue, showtime, ผังที่นั่ง/ราคาต่อโซน
- ดูรายการ booking ทั้งหมด + filter สถานะ, ค้นหาด้วยอีเมล/booking id
- ยกเลิก/คืนเงิน booking (ต้องมี audit log ว่าใครกดตอนไหน)
- Dashboard สรุปยอดขาย/ที่นั่งคงเหลือต่อรอบ

## 4.3 Sequence สั้นๆ (ตัวหนังสือแทน diagram)

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

## See also

- [`05-database-schema.md`](05-database-schema.md) — schema และ API endpoint ที่ flow นี้เรียกจริง
- [`../../Ticket-Booking-System-Plan.md`](../../Ticket-Booking-System-Plan.md) — สารบัญเอกสารทั้งหมด
