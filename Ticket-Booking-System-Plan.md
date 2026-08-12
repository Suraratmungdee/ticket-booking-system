# แผนออกแบบระบบจองตั๋ว (Ticket Booking System) ด้วย AI Coding Agent

Agent ที่เลือกใช้: **Claude Code** | Stack: Next.js 16 (frontend) + Node.js/Express (backend API แยก service) + TypeScript + PostgreSQL (Prisma) + Redis + Stripe — เหตุผลอยู่ใน `CLAUDE.md` หัวข้อ 2

เอกสารนี้เป็นสารบัญ — เนื้อหาจริงของสิ่งที่ต้องส่งมอบทั้ง 9 ข้อแยกไว้คนละไฟล์ เพื่อให้เปิดตรงแต่ละข้อได้ทันทีโดยไม่ต้องไล่หาในเอกสารยาว

## สิ่งที่ต้องส่งมอบ

1. **ไฟล์ Context/Instruction ของ Agent** → [`CLAUDE.md`](CLAUDE.md)
2. **Skill / Custom Command สำเร็จรูป** → [`.claude/commands/new-endpoint.md`](.claude/commands/new-endpoint.md)
3. **Plugin / MCP / Tool เสริมที่ใช้จริง** → [`docs/deliverables/03-tools-mcp.md`](docs/deliverables/03-tools-mcp.md)
4. **Flow Design ของระบบ** → [`docs/deliverables/04-flow-design.md`](docs/deliverables/04-flow-design.md)
5. **Schema ฐานข้อมูล** → [`docs/deliverables/05-database-schema.md`](docs/deliverables/05-database-schema.md)
6. **แผนการทำงานแบ่ง Phase พร้อม Checklist** → [`docs/deliverables/06-phase-plan.md`](docs/deliverables/06-phase-plan.md)
7. **Task Prompt จริงสำหรับ Phase แรก** → [`docs/deliverables/07-phase1-task-prompt.md`](docs/deliverables/07-phase1-task-prompt.md)
8. **จุดที่ AI ห้ามตัดสินใจเอง ต้องให้คน Review** → [`docs/deliverables/08-human-review-required.md`](docs/deliverables/08-human-review-required.md)
9. **แผนรับมือกรณี AI รายงานเสร็จผิด** → [`docs/deliverables/09-recovery-plan.md`](docs/deliverables/09-recovery-plan.md)

## เอกสารอื่นที่เกี่ยวข้อง

- [`README.md`](README.md) — วิธีติดตั้ง/รันระบบ, endpoint ปัจจุบันจริงทั้งหมด, สถานะงาน
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — คู่มือ deploy จริง, สิ่งที่ยังไม่เคย verify
- [`docs/superpowers/`](docs/superpowers/) — spec / plan / รายงาน review ละเอียดต่อ phase
