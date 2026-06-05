import { PrismaClient } from "@prisma/client";

// Single shared client per process. Workers and orchestrator each get their own.
export const prisma = new PrismaClient({
  log: process.env.PRISMA_LOG ? ["query", "warn", "error"] : ["warn", "error"],
});

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
