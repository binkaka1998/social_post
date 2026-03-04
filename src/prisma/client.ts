// src/prisma/client.ts
// Singleton Prisma client. Reused across the process lifetime.
// Prevents exhausting DB connection pool in repeated cron invocations.

import { PrismaClient } from '@prisma/client';
import { createLogger } from '../utils/logger';

const logger = createLogger('PrismaClient');

declare global {
  // Prevent multiple instances in development with hot-reload
  // eslint-disable-next-line no-var
  var __prismaInstance: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: [
      { level: 'warn', emit: 'event' },
      { level: 'error', emit: 'event' },
    ],
  });

  client.$on('warn', (e) => {
    logger.warn('Prisma warning', { message: e.message, target: e.target });
  });

  client.$on('error', (e) => {
    logger.error('Prisma error', undefined, { message: e.message, target: e.target });
  });

  return client;
}

export const prisma: PrismaClient =
  global.__prismaInstance ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.__prismaInstance = prisma;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
