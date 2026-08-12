# Phase 6 — Hardening + เตรียม deploy

**สถานะ:** อนุมัติแล้ว 12 ส.ค. 2026 · ต่อจาก Phase 5 (admin panel) ที่ merge เข้า `main` แล้วที่ `1ba1923`

## เป้าหมาย

ปิดช่องที่เหลือก่อนของจริงขึ้น production: security header, rate limit ที่ endpoint จอง, ความชัดเจนเรื่อง proxy, การพิสูจน์ว่าที่นั่งไม่ซ้อนภายใต้โหลดจริง และเอกสาร deploy/rollback ที่คนอ่านแล้วกดได้เอง

**ไม่ deploy จริงในเฟสนี้** แผนงานข้อ 6 ระบุว่า "คนตรวจสอบ (ไม่ใช่ agent) เป็นคน trigger deploy จริงครั้งแรก" และ `CLAUDE.md` §5 ห้าม agent deploy เอง เฟสนี้จบที่ "พร้อมให้คนกด"

## การตัดสินใจของคนที่กำหนดขอบเขตนี้

ทั้งสามข้อตัดสินเมื่อ 12 ส.ค. 2026:

1. **เตรียมให้พร้อม แต่คนกด deploy เอง** — ยังไม่เลือกผู้ให้บริการ เอกสารจึงต้องเขียนแบบไม่ผูกกับเจ้าใดเจ้าหนึ่ง
2. **เขียน security header middleware เอง ไม่ใช้ helmet** — API นี้ตอบ JSON อย่างเดียว ต้องการแค่ไม่กี่ header และ `CLAUDE.md` §2 ห้ามเพิ่ม dependency ที่ยังไม่จำเป็น
3. **load test เป็นสคริปต์ `fetch` + `Promise.all` ไม่ใช่ k6/autocannon** — คำถามที่ต้องตอบคือ "ที่นั่งซ้อนไหม" ไม่ใช่ throughput

**เฟสนี้ไม่เพิ่ม dependency ใดๆ ทั้งสิ้น**

## หลักการที่ยึด

**ค่า default ต้องปลอดภัยเมื่อเดาผิด** `TRUST_PROXY` ยังปิดไว้เหมือนเดิม เพราะเปิดไว้ทั้งที่ไม่มี proxy จริงคือการให้ client ปลอม IP ตัวเองได้ — อันตรายกว่าการที่ rate limiter ทำงานหยาบไป

**เตือนเมื่อ config น่าจะผิด แต่อย่าขวางเมื่ออาจถูก** boot guard ที่ throw ต้องสงวนไว้สำหรับกรณีที่ผิดแน่นอน ไม่ใช่กรณีที่แค่ผิดบ่อย

## 1. Security headers

`apps/api/src/middleware/security-headers.ts` — mount ก่อน route ทั้งหมดใน `index.ts`

| Header | ค่า | ทำไม |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | กันเบราว์เซอร์เดา content type จาก body |
| `X-Frame-Options` | `DENY` | API ไม่ควรถูก frame ไม่ว่ากรณีใด |
| `Referrer-Policy` | `no-referrer` | URL ของเรามี id ของ booking/ticket อยู่ อย่าให้รั่วไป origin อื่น |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | **เฉพาะเมื่อ `NODE_ENV === 'production'`** |

**HSTS ต้องไม่ตั้งตอน dev** ถ้าตั้ง เบราว์เซอร์จะจำว่า `localhost` ต้องเป็น HTTPS แล้วบังคับ redirect ทุกพอร์ตบน `localhost` ของเครื่องนั้นไปอีกนาน ล้างยาก และกระทบโปรเจกต์อื่นบนเครื่องเดียวกัน

**LIMITATION: ไม่ตั้ง CSP** เพราะ API นี้ไม่เสิร์ฟ HTML เลย CSP บน JSON response ไม่ได้ป้องกันอะไร วันไหนเสิร์ฟ HTML (error page, หน้า docs) ต้องเพิ่ม — ใส่ comment ไว้ที่ middleware

หมายเหตุ: หน้าเว็บ (`apps/web`) เป็นคนละ service ที่ Next.js เสิร์ฟ header ของมันตั้งใน `next.config` ไม่ใช่ที่นี่ **เฟสนี้ไม่แตะฝั่ง web**

## 2. Rate limit ที่ endpoint จอง

`POST /showtimes/:id/seats/hold` ต้องมี rate limit ไม่งั้นคนเดียวยิงรัวจนกวาดที่นั่งทั้งรอบเข้า hold ของตัวเองได้ (`MAX_SEATS_PER_BOOKING` จำกัดต่อ booking ไม่ได้จำกัดจำนวน booking)

**คีย์ด้วย `userId` ไม่ใช่ IP** — endpoint นี้ผ่าน `requireAuth` อยู่แล้ว จึงมี userId เสมอ และ userId มาจาก JWT ที่เราเซ็นเอง ไม่ใช่ header ที่ client ปลอมได้ ผลพลอยได้คือปัญหา proxy (ทุกคนกลายเป็น IP เดียว) หายไปเองบน endpoint นี้

ค่าคงที่ใหม่ใน `lib/config.ts` แยกจาก login คนละชุด พร้อมเหตุผลกำกับ:

```ts
export const BOOKING_RATE_LIMIT_MAX = 10
export const BOOKING_RATE_LIMIT_WINDOW_MS = 60 * 1000
```

10 ครั้ง/นาที กว้างพอสำหรับคนที่เลือกที่นั่งผิดแล้วลองใหม่หลายรอบ แคบพอที่จะไม่ให้ใครกวาดที่นั่งทั้งรอบ

### การแก้ `lib/rate-limit.ts`

โมดูลเดิม hardcode `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` ไว้ข้างในและใช้ `Map` ตัวเดียวร่วมกัน ต้องแก้ให้:

- รับ `max` และ `windowMs` เป็นพารามิเตอร์
- แยก bucket ต่อจุดใช้งาน (login กับ booking ต้องไม่กิน budget ของกัน)
- คงพฤติกรรมเดิมของ login ไว้ทุกอย่าง รวมถึงการจองสิทธิ์ก่อน `await` (`recordLoginFailure` ถูกเรียกก่อน `await loginUser(...)` เพื่อปิด check-then-act race — ห้ามทำหลุด)

นี่เป็นการแก้ที่จำเป็นต่องานนี้ ไม่ใช่ refactor ลอยๆ

**LIMITATION ที่ยังอยู่เหมือนเดิม (ยกมาไว้ที่เดียวให้ชัด):** state อยู่ใน memory ของ process เดียว — restart แล้วหาย และไม่ share ข้าม instance ถ้าวันไหนรันหลาย instance ต้องย้ายไป Redis (ซึ่งมีอยู่แล้วในสแตกสำหรับ seat lock)

## 3. `TRUST_PROXY` — จุดที่คนต้องตัดสินตอน deploy

ไม่เปลี่ยน default (ยังปิด) แต่เพิ่ม **คำเตือนตอน boot** เมื่อ `NODE_ENV === 'production'` และ `TRUST_PROXY` ไม่ได้เปิด:

> `TRUST_PROXY is off in production. If this process sits behind a reverse proxy (most PaaS), every request arrives as the proxy's IP and the login rate limiter will lock all users out together. If it does not, this is correct — see docs/DEPLOYMENT.md.`

**เป็น `console.warn` ไม่ใช่ throw** — deploy บน VPS ที่ไม่มี proxy คือ config ที่ถูกต้อง การ throw จะบล็อกการตั้งค่าที่ถูก ส่วน guard ที่ throw อยู่แล้ว (`JWT_SECRET`, secrets ที่เป็น placeholder) ยังคงเดิมทุกตัว เพราะกรณีเหล่านั้นผิดแน่นอน

## 4. Load test

`tests/load/booking-burst.ts` รันด้วย `tsx` ตอบคำถามเดียว:

> ยิงจองที่นั่งเดียวกันพร้อมกัน N คน — มีคนเดียวได้ที่นั่งจริงไหม

พิมพ์ออกมา: จำนวนที่สำเร็จ, จำนวนที่ 409, จำนวนที่ error อื่น, และ **จำนวนแถว `BookingSeat` ที่ชี้ไปที่ที่นั่งนั้นจริงในฐานข้อมูล** ตัวเลขสุดท้ายคือคำตอบ ต้องเป็น 1 เสมอ ผลลัพธ์จาก HTTP อย่างเดียวเชื่อไม่ได้

**ไม่ใช่ test ที่รันใน CI** ต้องมี API รันอยู่จริงและมี showtime ที่มีที่นั่งว่าง — เป็นสคริปต์ที่คนสั่งรันเอง มีวิธีรันใน `docs/DEPLOYMENT.md`

สร้าง fixture ของตัวเอง (user N คน + showtime + ที่นั่ง) และเก็บกวาดเฉพาะแถวที่ตัวเองสร้าง ตามแบบ `tests/integration/helpers.ts` — **ห้าม `deleteMany` ที่ไม่ scope** เพราะ Postgres ตัวนี้ worktree อื่นใช้ร่วมกัน

**LIMITATION: วัดแค่ความถูกต้อง ไม่วัด throughput/p95** ถ้าวันหน้าต้องรู้ว่ารับได้กี่ req/s ต้องใช้เครื่องมือจริง ซึ่งแปลว่าเพิ่ม dependency — ต้องถามคนก่อน

## 5. `docs/DEPLOYMENT.md`

เขียนแบบไม่ผูกกับผู้ให้บริการเจ้าใด ครอบคลุม:

**ตัวแปรที่บังคับใน production** — `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `TICKET_SIGNING_SECRET`, `FRONTEND_ORIGIN`, `NODE_ENV=production` พร้อมระบุว่าอันไหน boot guard จะ throw ให้เองถ้าลืมหรือยังเป็นค่า placeholder

**ตัวแปรที่ต้องตัดสินใจ** — `TRUST_PROXY` (มี proxy → `true`, VPS เปล่า → ปล่อยปิด), `PAYMENT_PROVIDER` (production ห้ามเป็น `mock` — boot guard throw ให้), `RESEND_API_KEY` (ไม่ตั้ง = อีเมลไม่ถูกส่ง แค่ log — **ยังไม่เคยมีใครยืนยันว่าส่งถึงจริง**)

**ลำดับ deploy** — รัน migration ให้จบก่อนสลับ traffic เพราะทุก migration เป็น additive โค้ดเก่าจึงยังทำงานกับ schema ใหม่ได้

**Rollback** — ข้อเท็จจริงสำคัญ: **migration ทุกตัวใน repo นี้เป็น additive ล้วน ไม่มี `DROP` เลยสักตัว** ตรวจซ้ำได้ด้วย `grep -ri "drop " apps/api/prisma/migrations/` แปลว่า revert โค้ดกลับได้โดยไม่ต้องย้อน schema ซึ่งเป็น rollback ที่ปลอดภัยที่สุด ถ้าจำเป็นต้องย้อน migration จริงๆ ให้ใช้ `prisma migrate resolve --rolled-back <name>` แล้วเขียน migration ใหม่ที่แก้กลับ — **ห้ามแก้ไฟล์ migration ที่ apply ไปแล้ว**

**สิ่งที่ยังไม่เคยตรวจ** — ต้องเขียนไว้ในเอกสารตรงๆ ไม่ใช่ซ่อน: อีเมลไม่เคยส่งจริง, ไม่มีใครเปิดหน้าเว็บ 6 หน้าที่สร้างใน Phase 4-5 ดูใน browser, ไม่มีใครสแกน QR ด้วยกล้อง

## Test ที่ต้องมี

1. security header ครบทุกตัวใน response (ยิงผ่าน handler จริง)
2. **HSTS ไม่โผล่เมื่อไม่ใช่ production** และโผล่เมื่อเป็น production
3. rate limiter: เกิน limit → `429`
4. **budget ของ user คนหนึ่งไม่กระทบอีกคน** (คีย์แยกจริง)
5. **login กับ booking ใช้ bucket แยกกัน** — จองจนเต็ม limit แล้วต้องยัง login ได้
6. หน้าต่างเวลาหมดแล้ว budget กลับมา
7. พฤติกรรม rate limit ของ login เดิมไม่เปลี่ยน (test เดิมทั้งหมดต้องยังเขียว โดยไม่แก้ assertion)

## สิ่งที่ตัดออกโดยตั้งใจ

| ตัดอะไร | เพิ่มเมื่อไหร่ |
|---|---|
| deploy จริง | คนกดเอง — แผนงานข้อ 6 และ `CLAUDE.md` §5 |
| CSP | API เริ่มเสิร์ฟ HTML |
| CORS preflight cache | มีปัญหา latency จริง |
| graceful shutdown | มี request ยาวจนโดนตัดกลางคันจริง |
| health check ที่เช็ค DB/Redis | มี orchestrator ที่ใช้ผลนั้นจริง |
| Sentry / APM | มีคนต้องดู error ใน production จริง (แผนงานข้อ 3 แนะนำไว้ — เป็น dependency ใหม่ ต้องถามคนก่อน) |
| CI/CD pipeline | มีคนมากกว่าหนึ่งคน deploy |
| rate limit ที่ `/bookings/:id/checkout` | endpoint นั้นสร้าง session เดิมซ้ำเมื่อกดซ้ำ (idempotent) จึงไม่ใช่ช่องทางกวาดทรัพยากร |

## Checklist ตรวจรับ (จากแผนงานข้อ 6)

- [ ] rate-limit endpoint login/booking กันสแปม — test 3-6 + สคริปต์ load test
- [ ] มี rollback plan (migration ย้อนกลับได้, ดู log deploy ได้) — `docs/DEPLOYMENT.md`
- [ ] **คนตรวจสอบ (ไม่ใช่ agent) เป็นคน trigger deploy จริงครั้งแรก** — เฟสนี้ไม่ปิดข้อนี้โดยตั้งใจ เอกสารพร้อม คนกดเอง
- [ ] `npm run build` + `npm test` ผ่านทั้งสอง app
