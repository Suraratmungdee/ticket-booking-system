---
description: สร้าง API endpoint ใหม่ตามมาตรฐานโปรเจกต์ (validation + state check + test)
argument-hint: [resource] [method] เช่น "bookings POST"
---

คุณกำลังจะสร้าง API endpoint ใหม่ใน `apps/api` (Express) สำหรับ resource: $1 method: $2

ทำตามลำดับนี้ ห้ามข้ามขั้นตอน:

1. **อ่านก่อนเขียน**: เปิด `apps/api/src/lib` และ `apps/api/src/routes` ดูว่ามี endpoint หรือ helper ที่ทำงานคล้ายกันอยู่แล้วหรือไม่ ถ้ามีให้ต่อยอด/reuse ห้ามเขียนซ้ำ
2. **เช็ค schema**: เปิด `apps/api/prisma/schema.prisma` ยืนยันว่า field ที่จะใช้มีอยู่จริง ถ้าต้องแก้ schema ให้หยุดและถามก่อน (schema เปลี่ยน = ต้อง review)
3. **เขียน validation** ด้วย zod (หรือ lib validation ที่ใช้อยู่แล้วในโปรเจกต์) ที่ต้น handler เสมอ — reject request ที่ข้อมูลไม่ครบ/ผิด type ก่อนแตะ DB
4. **เช็ค auth/role** ผ่าน middleware ที่มีอยู่แล้วใน `apps/api/src/middleware` (JWT verify + role check) ห้ามเขียน guard ใหม่ซ้ำในแต่ละ route
5. **เช็ค business state ก่อนเขียน DB** ถ้า endpoint เกี่ยวกับที่นั่ง/การจอง/เงิน เช่น ที่นั่งยังว่างจริงไหม, ยังไม่หมดเวลา lock ไหม — ใช้ฟังก์ชันที่มีอยู่ใน `apps/api/src/lib/booking.ts` หรือ `apps/api/src/lib/payment.ts` ห้าม query ตรงๆ ใน route
6. **เขียน handler ให้สั้นที่สุด** ที่ยังอ่านง่าย ไม่เพิ่ม abstraction ใหม่ถ้าโค้ดที่มีอยู่แล้วพอ
7. **เพิ่ม test อย่างน้อย 1 เคส** ใน `apps/api/tests` (หรือ path test ที่โปรเจกต์ใช้จริง) ที่ครอบคลุม happy path และ 1 เคส error ที่สำคัญที่สุด (เช่น จองที่นั่งที่ถูกจองไปแล้ว)
8. **รัน `npm run build && npm test`** ที่ workspace `apps/api` ก่อนบอกว่าเสร็จ ถ้าไม่ผ่านห้ามรายงานว่าเสร็จ
9. **สรุปท้ายงาน**: endpoint ใหม่คืออะไร, ไฟล์ไหนถูกแก้/สร้าง, ฝั่ง `apps/web` ต้องแก้ fetch call ไหนเพิ่มไหม, มีอะไรที่ต้องให้คน review เพิ่ม (เช่น ถ้าแตะ payment/schema)

ถ้า resource หรือ method ที่ระบุมายังไม่มี field/ตารางรองรับใน schema ให้หยุดทันทีและถามก่อนสร้าง table/column ใหม่เอง
