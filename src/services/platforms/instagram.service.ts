// src/services/platforms/instagram.service.ts
// Instagram Graph API integration.
// Instagram requires a TWO-PHASE flow:
//   Phase 1: Create a media container (returns container ID)
//   Phase 2: Publish the container (returns media ID)
//
// IMAGE STRATEGY:
//   - If news has an imageUrl, use it directly.
//   - If no image, use the configured fallback image (a branded placeholder).
//   - If no fallback either, we SKIP Instagram (can't post without image).
//     Instagram does not support text-only posts via the Graph API.
//
// The container must finish processing (status=FINISHED) before publishing.
// We poll the status with configurable max attempts + delay.

import axios, { AxiosError } from 'axios';
import { config } from '../../config/env';
import { PlatformResult, PublishPayload } from '../../types';
import { withRetry, DEFAULT_RETRY_OPTIONS } from '../../utils/retry';
import { createLogger } from '../../utils/logger';

const logger = createLogger('InstagramService');

interface ContainerCreateResponse {
  id: string;
}

interface ContainerStatusResponse {
  id: string;
  status_code: 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';
  status?: string;
}

interface PublishResponse {
  id: string;
}

interface InstagramApiError {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
  };
}

function parseInstagramError(error: AxiosError): string {
  const data = error.response?.data as InstagramApiError | undefined;
  if (data?.error) {
    const { message, type, code, error_subcode } = data.error;
    return `IG Error [${code}/${error_subcode}] (${type}): ${message}`;
  }
  return error.message;
}

function buildCaption(payload: PublishPayload): string {
  const { news } = payload;
  // Instagram caption limit: 2,200 characters
  const parts = [
    news.headlineVi,
    '',
    news.shortVi,
    '',
    `🔗 ${news.detailLink}`,
  ];
  return parts.join('\n').substring(0, 2200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class InstagramService {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = `https://graph.facebook.com/${config.instagram.apiVersion}`;
  }

  async post(payload: PublishPayload): Promise<PlatformResult> {
    const { news } = payload;
    const logCtx = { newsId: news.id, platform: 'instagram' };

    // Determine image URL — Instagram REQUIRES an image
    const imageUrl = payload.imageUrl || config.instagram.fallbackImageUrl;

    if (!imageUrl) {
      logger.warn('Skipping Instagram post: no image URL and no fallback configured', logCtx);
      return {
        platform: 'instagram',
        success: false,
        skipped: true,
        error: 'No image available and no fallback image configured',
      };
    }

    logger.info('Starting Instagram post', { ...logCtx, hasImage: !!payload.imageUrl, usingFallback: !payload.imageUrl });

    try {
      // Phase 1: Create media container
      const containerId = await withRetry(
        () => this.createContainer(imageUrl, buildCaption(payload)),
        'instagram',
        { ...logCtx, phase: 'create_container' },
        {
          ...DEFAULT_RETRY_OPTIONS,
          maxAttempts: config.publisher.maxRetries,
          baseDelayMs: config.publisher.retryBaseDelayMs,
          maxDelayMs: config.publisher.retryMaxDelayMs,
        }
      );

      logger.info('Instagram container created', { ...logCtx, containerId });

      // Phase 2: Poll until container is FINISHED
      await this.pollContainerStatus(containerId, logCtx);

      // Phase 3: Publish the container
      const mediaId = await withRetry(
        () => this.publishContainer(containerId),
        'instagram',
        { ...logCtx, phase: 'publish_container', containerId },
        {
          ...DEFAULT_RETRY_OPTIONS,
          maxAttempts: config.publisher.maxRetries,
          baseDelayMs: config.publisher.retryBaseDelayMs,
          maxDelayMs: config.publisher.retryMaxDelayMs,
        }
      );

      logger.info('Instagram post published successfully', { ...logCtx, mediaId, containerId });

      return {
        platform: 'instagram',
        success: true,
        postId: mediaId,
      };
    } catch (error) {
      const message = error instanceof AxiosError
        ? parseInstagramError(error)
        : error instanceof Error ? error.message : String(error);

      logger.error('Instagram post failed permanently', error, { ...logCtx, errorMessage: message });

      return {
        platform: 'instagram',
        success: false,
        error: message,
      };
    }
  }

  private async createContainer(imageUrl: string, caption: string): Promise<string> {
    const url = `${this.baseUrl}/${config.instagram.accountId}/media`;

    const response = await axios.post<ContainerCreateResponse>(
      url,
      {
        image_url: imageUrl,
        caption,
        access_token: config.instagram.accessToken,
      },
      {
        timeout: config.publisher.httpTimeoutMs,
        headers: { 'User-Agent': 'SocialPublisher/1.0' },
      }
    );

    return response.data.id;
  }

  /**
   * Polls the container status until FINISHED or ERROR/EXPIRED.
   * Instagram media processing is async and can take several seconds.
   */
  private async pollContainerStatus(
    containerId: string,
    logCtx: Record<string, unknown>
  ): Promise<void> {
    const { instagramPollMaxAttempts, instagramPollDelayMs } = config.publisher;
    const url = `${this.baseUrl}/${containerId}`;

    for (let attempt = 1; attempt <= instagramPollMaxAttempts; attempt++) {
      logger.debug('Polling Instagram container status', { ...logCtx, containerId, attempt });

      const response = await axios.get<ContainerStatusResponse>(url, {
        params: {
          fields: 'id,status_code,status',
          access_token: config.instagram.accessToken,
        },
        timeout: config.publisher.httpTimeoutMs,
      });

      const { status_code, status } = response.data;

      if (status_code === 'FINISHED') {
        logger.info('Instagram container ready', { ...logCtx, containerId, attempt });
        return;
      }

      if (status_code === 'ERROR' || status_code === 'EXPIRED') {
        throw new Error(
          `Instagram container ${containerId} processing failed: status=${status_code}, detail=${status ?? 'none'}`
        );
      }

      // IN_PROGRESS — keep polling
      if (attempt < instagramPollMaxAttempts) {
        await sleep(instagramPollDelayMs);
      }
    }

    throw new Error(
      `Instagram container ${containerId} did not finish processing after ${instagramPollMaxAttempts} poll attempts`
    );
  }

  private async publishContainer(containerId: string): Promise<string> {
    const url = `${this.baseUrl}/${config.instagram.accountId}/media_publish`;

    const response = await axios.post<PublishResponse>(
      url,
      {
        creation_id: containerId,
        access_token: config.instagram.accessToken,
      },
      {
        timeout: config.publisher.httpTimeoutMs,
        headers: { 'User-Agent': 'SocialPublisher/1.0' },
      }
    );

    return response.data.id;
  }
}
