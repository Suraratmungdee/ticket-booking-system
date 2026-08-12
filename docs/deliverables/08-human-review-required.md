# 8. จุดที่ AI ห้ามตัดสินใจเอง ต้องให้คน Review/Approve ก่อน

- **Payment provider และ credential**: เลือก Stripe/Omise/2C2P, ราคา, ค่าธรรมเนียม, refund policy — เป็นการตัดสินใจทางธุรกิจ ไม่ใช่เทคนิค
- **Production database migration**: agent เขียน migration ได้ แต่การ "รัน" กับ DB จริงต้องเป็นคนกดเอง
- **Deploy ขึ้น production / merge เข้า main**: agent เปิด PR ได้ แต่การ approve+merge+deploy ต้องเป็นคน
- **การลบข้อมูล** (user, booking, payment) แม้จะดูเหมือนข้อมูลทดสอบ
- **การปิด/ข้าม security check** เช่น webhook signature verification, auth guard บนหน้า admin แม้จะอ้างว่าเพื่อ debug ชั่วคราว
- **การเปลี่ยนแปลงที่กระทบผู้ใช้จริง** เช่น ยกเลิก booking ของคนอื่น, เปลี่ยนเวลา hold ที่นั่งที่ตกลงกันไว้แล้ว
- **การเพิ่ม dependency/service ใหม่** (queue, microservice, MCP ใหม่) ที่ยังไม่ได้ระบุไว้ใน CLAUDE.md

หลักการ: **ทุกอย่างที่ rollback ยากหรือกระทบเงิน/ข้อมูลจริง → คนต้องกดปุ่มสุดท้ายเสมอ**

ตรงกับกติกาเดียวกันที่บังคับใช้จริงตลอดโปรเจกต์ใน [`../../CLAUDE.md`](../../CLAUDE.md) หัวข้อ 5

## See also

- [`../../CLAUDE.md`](../../CLAUDE.md) — กติกาโปรเจกต์ฉบับเต็มที่ agent อ่านจริงทุกครั้งก่อนแก้โค้ด
- [`09-recovery-plan.md`](09-recovery-plan.md)
- [`../../Ticket-Booking-System-Plan.md`](../../Ticket-Booking-System-Plan.md) — สารบัญเอกสารทั้งหมด
