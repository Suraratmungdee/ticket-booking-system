# 3. Plugin / MCP / Tool เสริม

> **ปรับปรุง 13 ส.ค. 2569:** เช็คแล้ว `.claude/settings.json` และไม่มี `.mcp.json` ในโปรเจกต์ — **ไม่มี MCP server ตัวไหนถูกติดตั้งจริงตลอด 6 phase ที่ผ่านมา** งานทั้งหมดทำด้วย Claude Code's built-in tools (Bash/Read/Edit) ล้วนๆ บวก CLI ที่เป็น dependency ของโปรเจกต์อยู่แล้ว ไม่มีอะไรเพิ่มเติมนอกเหนือจากนี้

| เครื่องมือ | ใช้ทำอะไรจริง |
|---|---|
| `npx prisma` (migrate/generate) | สร้างและรัน migration ทุกตัวใน `apps/api/prisma/migrations/` |
| `npx vitest` | รัน unit test (186 เคส) และ integration test (10 เคส) |
| `curl` | ยิง API ตรงเพื่อยืนยันพฤติกรรมจริง (login/CORS/preflight) แทนการเดาจากโค้ดอย่างเดียว — ใช้ตอนไล่บั๊ก `/admin` |
| `docker compose` | รัน Postgres + Redis dev ตาม `docker-compose.yml` |

## See also

- [`../../CLAUDE.md`](../../CLAUDE.md) — กติกาโปรเจกต์
- [`../../Ticket-Booking-System-Plan.md`](../../Ticket-Booking-System-Plan.md) — สารบัญเอกสารทั้งหมด
