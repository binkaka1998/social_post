// src/utils/retry.ts
// Production-grade retry utility with exponential backoff + jitter.
// Classifies HTTP errors into retryable vs non-retryable categories.

import { AxiosError } from 'axios';
import { RetryOptions, Platform } from '../types';
import { createLogger } from './logger';

const logger = createLogger('RetryUtil');

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  factor: 2,
};

/**
 * Determines if an Axios error should be retried.
 * 
 * Retryable:
 *   - Network errors (ECONNREFUSED, ETIMEDOUT, ENOTFOUND, etc.)
 *   - HTTP 429 Too Many Requests
 *   - HTTP 500, 502, 503, 504 Server Errors
 * 
 * Not retryable:
 *   - HTTP 400 Bad Request (bad data, won't fix itself)
 *   - HTTP 401 Unauthorized (token issue, needs human intervention)
 *   - HTTP 403 Forbidden
 *   - HTTP 404 Not Found
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // Network-level errors (no response received)
  const axiosError = error as AxiosError;
  if (!axiosError.response) {
    const networkCodes = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EPIPE'];
    const code = axiosError.code;
    if (code && networkCodes.includes(code)) return true;
    // Timeout from axios
    if (axiosError.code === 'ECONNABORTED') return true;
    // No response and no specific code = network issue, retry
    return true;
  }

  const status = axiosError.response.status;

  // Rate limited — retryable (with backoff)
  if (status === 429) return true;

  // Server errors — retryable
  if (status >= 500 && status <= 599) return true;

  // Client errors — NOT retryable
  // 400: bad payload, 401: auth failure, 403: permissions, 404: not found
  return false;
}

/**
 * Extracts the Retry-After header value (seconds) from a 429 response.
 * Returns null if not present or unparseable.
 */
export function extractRetryAfterMs(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const axiosError = error as AxiosError;
  if (!axiosError.response) return null;

  const retryAfter = axiosError.response.headers['retry-after'];
  if (!retryAfter) return null;

  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) return seconds * 1000;

  // Could be a date string
  const date = new Date(retryAfter);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }

  return null;
}

/**
 * Computes delay for attempt N with full jitter to avoid thundering herd.
 * Full jitter: delay = random(0, min(cap, base * factor^attempt))
 */
export function computeBackoffDelay(attempt: number, options: RetryOptions): number {
  const exponential = options.baseDelayMs * Math.pow(options.factor, attempt);
  const capped = Math.min(options.maxDelayMs, exponential);
  // Full jitter
  return Math.floor(Math.random() * capped);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes an async operation with retry logic.
 * 
 * @param operation - The async function to retry
 * @param platform - The platform name (for logging context)
 * @param context - Additional context for logging (e.g., newsId)
 * @param options - Retry configuration
 * @returns The result of the operation
 * @throws The last error if all attempts exhausted
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  platform: Platform,
  context: Record<string, unknown>,
  options: RetryOptions = DEFAULT_RETRY_OPTIONS
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      const result = await operation();
      if (attempt > 0) {
        logger.info('Operation succeeded after retry', { platform, attempt, ...context });
      }
      return result;
    } catch (error) {
      lastError = error;

      const retryable = isRetryableError(error);
      const isLastAttempt = attempt === options.maxAttempts - 1;

      // Log every failure with full context
      const statusCode = (error as AxiosError)?.response?.status;
      logger.warn('Operation attempt failed', {
        platform,
        attempt: attempt + 1,
        maxAttempts: options.maxAttempts,
        retryable,
        statusCode,
        errorMessage: error instanceof Error ? error.message : String(error),
        ...context,
      });

      if (!retryable || isLastAttempt) {
        logger.error('Operation failed permanently', error, {
          platform,
          totalAttempts: attempt + 1,
          retryable,
          ...context,
        });
        throw error;
      }

      // Honor Retry-After header for 429 responses
      const retryAfterMs = extractRetryAfterMs(error);
      const delay = retryAfterMs !== null
        ? retryAfterMs
        : computeBackoffDelay(attempt, options);

      logger.info('Scheduling retry', {
        platform,
        attempt: attempt + 1,
        nextAttempt: attempt + 2,
        delayMs: delay,
        ...context,
      });

      await sleep(delay);
    }
  }

  throw lastError;
}
