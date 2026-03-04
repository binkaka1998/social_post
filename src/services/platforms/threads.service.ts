// src/services/platforms/threads.service.ts
// Threads API integration.
// Threads also uses a two-phase approach (create container → publish),
// similar to Instagram (they share Meta's infrastructure).
//
// Threads supports TEXT-ONLY posts unlike Instagram.
// If an image is available, we post as IMAGE type; otherwise TEXT type.
//
// Threads API base: https://graph.threads.net/v1.0/

import axios, { AxiosError } from 'axios';
import { config } from '../../config/env';
import { PlatformResult, PublishPayload } from '../../types';
import { withRetry, DEFAULT_RETRY_OPTIONS } from '../../utils/retry';
import { createLogger } from '../../utils/logger';

const logger = createLogger('ThreadsService');

type ThreadsMediaType = 'TEXT' | 'IMAGE';

interface ThreadsContainerResponse {
  id: string;
}

interface ThreadsPublishResponse {
  id: string;
}

interface ThreadsStatusResponse {
  id: string;
  status: 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';
  error_message?: string;
}

interface ThreadsApiError {
  error?: {
    message?: string;
    code?: number;
    type?: string;
  };
}

function parseThreadsError(error: AxiosError): string {
  const data = error.response?.data as ThreadsApiError | undefined;
  if (data?.error) {
    const { message, type, code } = data.error;
    return `Threads Error [${code}] (${type}): ${message}`;
  }
  return error.message;
}

function buildThreadsText(payload: PublishPayload): string {
  const { news } = payload;
  // Threads has a 500 character limit
  const headline = news.headlineVi;
  const link = `\n\n${news.detailLink}`;
  const maxBody = 500 - link.length;
  const truncated = headline != null ? (headline.length > maxBody
    ? headline.substring(0, maxBody - 3) + '...'
    : headline) : '';
  return truncated + link;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ThreadsService {
  private readonly baseUrl: string;

  constructor() {
    // Threads API uses graph.threads.net (separate from graph.facebook.com)
    this.baseUrl = `https://graph.threads.net/${config.threads.apiVersion}`;
  }

  async post(payload: PublishPayload): Promise<PlatformResult> {
    const { news } = payload;
    const logCtx = { newsId: news.id, platform: 'threads' };
    const mediaType: ThreadsMediaType = payload.imageUrl ? 'IMAGE' : 'TEXT';

    logger.info('Starting Threads post', { ...logCtx, mediaType });

    try {
      // Phase 1: Create container
      const containerId = await withRetry(
        () => this.createContainer(payload, mediaType),
        'threads',
        { ...logCtx, phase: 'create_container' },
        {
          ...DEFAULT_RETRY_OPTIONS,
          maxAttempts: config.publisher.maxRetries,
          baseDelayMs: config.publisher.retryBaseDelayMs,
          maxDelayMs: config.publisher.retryMaxDelayMs,
        }
      );

      logger.info('Threads container created', { ...logCtx, containerId, mediaType });

      // Phase 2: Poll until ready
      await this.pollContainerStatus(containerId, logCtx);

      // Phase 3: Publish
      const postId = await withRetry(
        () => this.publishContainer(containerId),
        'threads',
        { ...logCtx, phase: 'publish', containerId },
        {
          ...DEFAULT_RETRY_OPTIONS,
          maxAttempts: config.publisher.maxRetries,
          baseDelayMs: config.publisher.retryBaseDelayMs,
          maxDelayMs: config.publisher.retryMaxDelayMs,
        }
      );

      logger.info('Threads post published successfully', { ...logCtx, postId });

      return {
        platform: 'threads',
        success: true,
        postId,
      };
    } catch (error) {
      const message = error instanceof AxiosError
        ? parseThreadsError(error)
        : error instanceof Error ? error.message : String(error);

      logger.error('Threads post failed permanently', error, { ...logCtx, errorMessage: message });

      return {
        platform: 'threads',
        success: false,
        error: message,
      };
    }
  }

  private async createContainer(
    payload: PublishPayload,
    mediaType: ThreadsMediaType
  ): Promise<string> {
    const url = `${this.baseUrl}/${config.threads.userId}/threads`;
    const text = buildThreadsText(payload);

    const body: Record<string, string> = {
      media_type: mediaType,
      text,
      access_token: config.threads.accessToken,
    };

    if (mediaType === 'IMAGE' && payload.imageUrl) {
      body.image_url = payload.imageUrl;
    }

    const response = await axios.post<ThreadsContainerResponse>(url, body, {
      timeout: config.publisher.httpTimeoutMs,
      headers: { 'User-Agent': 'SocialPublisher/1.0' },
    });

    return response.data.id;
  }

  private async pollContainerStatus(
    containerId: string,
    logCtx: Record<string, unknown>
  ): Promise<void> {
    const { instagramPollMaxAttempts, instagramPollDelayMs } = config.publisher;
    const url = `${this.baseUrl}/${containerId}`;

    for (let attempt = 1; attempt <= instagramPollMaxAttempts; attempt++) {
      logger.debug('Polling Threads container status', { ...logCtx, containerId, attempt });

      const response = await axios.get<ThreadsStatusResponse>(url, {
        params: {
          fields: 'id,status,error_message',
          access_token: config.threads.accessToken,
        },
        timeout: config.publisher.httpTimeoutMs,
      });

      const { status, error_message } = response.data;

      if (status === 'FINISHED') {
        logger.info('Threads container ready', { ...logCtx, containerId, attempt });
        return;
      }

      if (status === 'ERROR' || status === 'EXPIRED') {
        throw new Error(
          `Threads container ${containerId} failed: status=${status}, error=${error_message ?? 'none'}`
        );
      }

      if (attempt < instagramPollMaxAttempts) {
        await sleep(instagramPollDelayMs);
      }
    }

    throw new Error(
      `Threads container ${containerId} did not finish after ${instagramPollMaxAttempts} poll attempts`
    );
  }

  private async publishContainer(containerId: string): Promise<string> {
    const url = `${this.baseUrl}/${config.threads.userId}/threads_publish`;

    const response = await axios.post<ThreadsPublishResponse>(
      url,
      {
        creation_id: containerId,
        access_token: config.threads.accessToken,
      },
      {
        timeout: config.publisher.httpTimeoutMs,
        headers: { 'User-Agent': 'SocialPublisher/1.0' },
      }
    );

    return response.data.id;
  }
}
