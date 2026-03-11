// src/config/.env.ts
// Centralized, validated environment configuration.
// Fails fast at startup if any required variable is missing.

import dotenv from 'dotenv';

dotenv.config();
function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(`[Config] Missing required environment variable: ${key}`);
  }
  return value.trim();
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key]?.trim() || defaultValue;
}

function optionalEnvInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  if (isNaN(parsed)) {
    throw new Error(`[Config] Environment variable ${key} must be an integer, got: "${val}"`);
  }
  return parsed;
}

// Validate and freeze config at module load time — fail immediately if broken
export const config = Object.freeze({
  // Database
  database: {
    url: requireEnv('DATABASE_URL'),
  },

  // Facebook Graph API
  facebook: {
    pageId: requireEnv('FACEBOOK_PAGE_ID'),
    accessToken: requireEnv('FACEBOOK_PAGE_ACCESS_TOKEN'),
    apiVersion: optionalEnv('FACEBOOK_API_VERSION', 'v19.0'),
  },

  // Instagram Graph API (Business Account linked to Facebook Page)
  instagram: {
    accountId: requireEnv('INSTAGRAM_ACCOUNT_ID'),
    accessToken: requireEnv('INSTAGRAM_ACCESS_TOKEN'),
    apiVersion: optionalEnv('INSTAGRAM_API_VERSION', 'v19.0'),
    // Fallback image when no image is available from the article
    fallbackImageUrl: optionalEnv(
      'INSTAGRAM_FALLBACK_IMAGE_URL',
      ''
    ),
  },

  // Threads API
  // threads: {
  //   userId: requireEnv('THREADS_USER_ID'),
  //   accessToken: requireEnv('THREADS_ACCESS_TOKEN'),
  //   apiVersion: optionalEnv('THREADS_API_VERSION', 'v1.0'),
  // },

  // Publisher behavior
  publisher: {
    // Max news items to process per cron run
    batchSize: optionalEnvInt('PUBLISHER_BATCH_SIZE', 5),
    // Max retry attempts per platform per news item
    maxRetries: optionalEnvInt('PUBLISHER_MAX_RETRIES', 3),
    // Base delay for exponential backoff (ms)
    retryBaseDelayMs: optionalEnvInt('PUBLISHER_RETRY_BASE_DELAY_MS', 1000),
    // Max delay cap for backoff (ms)
    retryMaxDelayMs: optionalEnvInt('PUBLISHER_RETRY_MAX_DELAY_MS', 30000),
    // Stale lock threshold: if socialProcessingAt is older than this, unlock it (ms)
    staleLockThresholdMs: optionalEnvInt('PUBLISHER_STALE_LOCK_THRESHOLD_MS', 5 * 60 * 1000),
    // HTTP request timeout per API call (ms)
    httpTimeoutMs: optionalEnvInt('PUBLISHER_HTTP_TIMEOUT_MS', 15000),
    // Instagram container polling: max attempts
    instagramPollMaxAttempts: optionalEnvInt('INSTAGRAM_POLL_MAX_ATTEMPTS', 10),
    // Instagram container polling: delay between polls (ms)
    instagramPollDelayMs: optionalEnvInt('INSTAGRAM_POLL_DELAY_MS', 3000),
  },

  // Logging
  logging: {
    level: optionalEnv('LOG_LEVEL', 'info'),
    // 'json' for production, 'pretty' for local dev
    format: optionalEnv('LOG_FORMAT', 'json') as 'json' | 'pretty',
    dir: optionalEnv('LOG_DIR', './logs'),
  },

  // Runtime
  nodeEnv: optionalEnv('NODE_ENV', 'production'),
});

export type Config = typeof config;
