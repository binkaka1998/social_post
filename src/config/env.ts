// src/config/env.ts
// Centralized, validated environment configuration.
// Works for both local .env and GitHub Actions secrets.

import dotenv from 'dotenv';

// Load .env only if present (safe for CI)
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === '') {
    throw new Error(`[Config] Missing required environment variable: ${key}`);
  }
  return value.trim();
}

function optionalEnv(key: string, defaultValue: string): string {
  const value = process.env[key];
  return value && value.trim() !== '' ? value.trim() : defaultValue;
}

function optionalEnvInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;

  const parsed = parseInt(val, 10);
  if (isNaN(parsed)) {
    throw new Error(
        `[Config] Environment variable ${key} must be an integer, got: "${val}"`
    );
  }

  return parsed;
}

// Freeze config so it cannot be mutated at runtime
export const config = Object.freeze({
  // Database
  database: {
    url: requireEnv('DATABASE_URL'),
  },

  // Facebook Graph API
  facebook: {
    pageId: requireEnv('FACEBOOK_PAGE_ID'),
    accessToken: requireEnv('FACEBOOK_PAGE_ACCESS_TOKEN'),
    apiVersion: optionalEnv('FACEBOOK_API_VERSION', 'v25.0'),
  },

  // Instagram Graph API
  instagram: {
    accountId: requireEnv('INSTAGRAM_ACCOUNT_ID'),
    accessToken: requireEnv('INSTAGRAM_ACCESS_TOKEN'),
    apiVersion: optionalEnv('INSTAGRAM_API_VERSION', 'v25.0'),
    fallbackImageUrl: optionalEnv('INSTAGRAM_FALLBACK_IMAGE_URL', ''),
  },

  // Publisher behavior
  publisher: {
    batchSize: optionalEnvInt('PUBLISHER_BATCH_SIZE', 5),
    maxRetries: optionalEnvInt('PUBLISHER_MAX_RETRIES', 3),
    retryBaseDelayMs: optionalEnvInt('PUBLISHER_RETRY_BASE_DELAY_MS', 1000),
    retryMaxDelayMs: optionalEnvInt('PUBLISHER_RETRY_MAX_DELAY_MS', 30000),
    staleLockThresholdMs: optionalEnvInt(
        'PUBLISHER_STALE_LOCK_THRESHOLD_MS',
        5 * 60 * 1000
    ),
    httpTimeoutMs: optionalEnvInt('PUBLISHER_HTTP_TIMEOUT_MS', 15000),
    instagramPollMaxAttempts: optionalEnvInt('INSTAGRAM_POLL_MAX_ATTEMPTS', 10),
    instagramPollDelayMs: optionalEnvInt('INSTAGRAM_POLL_DELAY_MS', 3000),
  },

  // Logging
  logging: {
    level: optionalEnv('LOG_LEVEL', 'info'),
    format: optionalEnv('LOG_FORMAT', 'json') as 'json' | 'pretty',
    dir: optionalEnv('LOG_DIR', './logs'),
  },

  // Runtime
  nodeEnv: optionalEnv('NODE_ENV', 'production'),
});

export type Config = typeof config;
