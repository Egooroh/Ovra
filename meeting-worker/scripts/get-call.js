const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
p.call.findFirst({ where: { status: "SCHEDULED" }, orderBy: { startsAt: "asc" } })
  .then(c => { console.log(JSON.stringify(c, null, 2)); return p.$disconnect(); })
  .catch(e => { console.error(e); process.exit(1); });
