// src/services/platforms/facebook.service.ts
// Facebook Graph API integration.
// Posts text + optional link to a Facebook Page.
// Handles token errors, rate limits, and API-specific error codes.

import axios, { AxiosError } from 'axios';
import { config } from '../../config/env';
import { PlatformResult, PublishPayload } from '../../types';
import { withRetry, DEFAULT_RETRY_OPTIONS } from '../../utils/retry';
import { createLogger } from '../../utils/logger';

const logger = createLogger('FacebookService');

interface FacebookApiErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

interface FacebookPostResponse {
  id: string;
}

/**
 * Builds the post message text from the news payload.
 * Facebook supports up to 63,206 characters.
 */
function buildPostMessage(payload: PublishPayload): string {
  const { news } = payload;
  const parts: string[] = [];

  parts.push(news.headlineVi ?? '');
  parts.push('');
  parts.push(news.shortVi  ?? '');
  parts.push('');
  parts.push(news.detailLink);

  return parts.join('\n').substring(0, 63000);
}

/**
 * Parses Facebook API error responses into structured form.
 * Facebook returns errors as JSON even on 4xx/5xx.
 */
function parseFacebookError(error: AxiosError): string {
  const data = error.response?.data as FacebookApiErrorBody | undefined;
  if (data?.error) {
    const { message, type, code, error_subcode } = data.error;
    return `FB Error [${code}/${error_subcode}] (${type}): ${message}`;
  }
  return error.message;
}

/**
 * Some Facebook error codes are non-retryable regardless of HTTP status:
 * - 190: Invalid OAuth token
 * - 200: Permissions error
 * - 10: Application does not have permission
 * - 368: Temporarily blocked (abuse detection)
 */
function isFacebookNonRetryableCode(error: AxiosError): boolean {
  const data = error.response?.data as FacebookApiErrorBody | undefined;
  const code = data?.error?.code;
  if (!code) return false;
  return [190, 200, 10, 4, 17].includes(code);
}

export class FacebookService {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = `https://graph.facebook.com/${config.facebook.apiVersion}`;
  }

  async post(payload: PublishPayload): Promise<PlatformResult> {
    const { news } = payload;
    const logCtx = { newsId: news.id, platform: 'facebook' };

    logger.info('Starting Facebook post', logCtx);

    try {
      const result = await withRetry(
        () => this.executePost(payload),
        'facebook',
        logCtx,
        {
          ...DEFAULT_RETRY_OPTIONS,
          maxAttempts: config.publisher.maxRetries,
          baseDelayMs: config.publisher.retryBaseDelayMs,
          maxDelayMs: config.publisher.retryMaxDelayMs,
        }
      );

      logger.info('Facebook post successful', { ...logCtx, postId: result.id });

      return {
        platform: 'facebook',
        success: true,
        postId: result.id,
      };
    } catch (error) {
      const message = error instanceof AxiosError
        ? parseFacebookError(error)
        : error instanceof Error ? error.message : String(error);

      logger.error('Facebook post failed permanently', error, { ...logCtx, errorMessage: message });

      return {
        platform: 'facebook',
        success: false,
        error: message,
      };
    }
  }

  private async executePost(payload: PublishPayload): Promise<FacebookPostResponse> {
    const message = buildPostMessage(payload);
    const url = `${this.baseUrl}/${config.facebook.pageId}/feed`;

    const body: Record<string, string> = {
      message,
      // Include link separately for link preview card (Facebook will extract OG tags)
      link: payload.news.detailLink,
      access_token: config.facebook.accessToken,
    };
    try {
      const response = await axios.post<FacebookPostResponse>(url, body, {
        timeout: config.publisher.httpTimeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'SocialPublisher/1.0',
        },
      });

      return response.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        // Override retryability for known Facebook non-retryable codes
        if (isFacebookNonRetryableCode(error)) {
          const message = parseFacebookError(error);
          // Wrap as a non-retryable error by throwing a plain Error (not AxiosError)
          // Our isRetryableError util only retries AxiosErrors with no/5xx responses
          throw new Error(`[NonRetryable] ${message}`);
        }
      }
      throw error;
    }
  }
}
