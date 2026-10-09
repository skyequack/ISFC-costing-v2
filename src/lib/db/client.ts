import { PrismaClient } from '@prisma/client';

const g = globalThis as unknown as { __prisma?: PrismaClient };

/** Single PrismaClient per runtime (pooled DATABASE_URL). */
export const prisma: PrismaClient = g.__prisma ?? (g.__prisma = new PrismaClient());
