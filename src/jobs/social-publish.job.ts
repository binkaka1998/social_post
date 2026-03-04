// src/jobs/social-publish.job.ts
// Cron job entry point for the social publisher.
// Designed to be called by cron or PM2 cron mode.
//
// EXECUTION CONTRACT:
//   - The job must complete within the cron interval (e.g. 5 minutes for a 5-minute cron).
//   - The job is idempotent: re-running it won't re-post already-posted items.
//   - The job is safe to run concurrently (atomic locking in the service).
//   - Exits with code 0 on success, code 1 on fatal errors.
//
// INVOCATION:
//   node dist/jobs/social-publish.job.js
//   OR via PM2 cron_restart or systemd timer

import { SocialPublisherService } from '../services/social-publisher.service';
import { disconnectPrisma } from '../prisma/client';
import { createLogger } from '../utils/logger';
import { config } from '../config/env'; // Validates .env vars at import time

const logger = createLogger('SocialPublishJob');

async function main(): Promise<void> {
  const startTime = Date.now();
  logger.info('Social publish job starting', {
    nodeEnv: config.nodeEnv,
    batchSize: config.publisher.batchSize,
    pid: process.pid,
  });

  const service = new SocialPublisherService();

  try {
    await service.run();
    const durationMs = Date.now() - startTime;
    logger.info('Social publish job completed successfully', { durationMs });
  } catch (error) {
    const durationMs = Date.now() - startTime;
    logger.error('Social publish job failed with unhandled error', error, { durationMs });
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}

// Handle unhandled promise rejections (safety net)
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection in social publish job', reason as Error);
  process.exitCode = 1;
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception in social publish job', error);
  process.exitCode = 1;
  process.exit(1);
});

main().catch((error) => {
  logger.error('Top-level job execution failed', error);
  process.exit(1);
});
