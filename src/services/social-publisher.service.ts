// src/services/social-publisher.service.ts
// Central orchestrator for the social publishing pipeline.
//
// CONCURRENCY SAFETY:
//   Uses an atomic "claim" pattern via Prisma's updateMany with a WHERE clause
//   that includes socialProcessing=false. Only one process can set the flag to
//   true for a given row. This is safe under concurrent cron runs or multiple
//   instances because PostgreSQL's row-level locking guarantees that only one
//   UPDATE wins when multiple processes race on the same row.
//
//   Stale lock detection: if socialProcessingAt is older than the configured
//   threshold, the lock is considered stale and will be reset before the next
//   cron run claims it.
//
// PARTIAL FAILURE HANDLING:
//   Each platform is attempted independently. A failure on Facebook does NOT
//   prevent Instagram or Threads from being attempted. Each platform flag is
//   updated independently in the database.
//
// POST CONTENT ASSEMBLY:
//   Currently builds text from DB fields. In a future version, this is where
//   you'd call an OG scraper or CMS to extract the article's main image URL.

import { prisma } from '../prisma/client';
import { FacebookService } from './platforms/facebook.service';
import { InstagramService } from './platforms/instagram.service';
// import { ThreadsService } from './platforms/threads.service';
import { config } from '../config/env';
import { createLogger } from '../utils/logger';
import type { NewsRecord, PlatformResult, PublishPayload, PublishResult } from '../types';
import type { News } from '@prisma/client';

const logger = createLogger('SocialPublisherService');

export class SocialPublisherService {
  private readonly facebook: FacebookService;
  private readonly instagram: InstagramService;
  // private readonly threads: ThreadsService;

  constructor() {
    this.facebook = new FacebookService();
    this.instagram = new InstagramService();
    // this.threads = new ThreadsService();
  }

  /**
   * Main entry point. Called by the cron job.
   * Processes up to batchSize news items per run.
   */
  async run(): Promise<void> {
    logger.info('Social publisher run started', { batchSize: config.publisher.batchSize });

    try {
      // Step 1: Release any stale locks from crashed previous runs
      await this.releaseStaleLocks();

      // Step 2: Atomically claim eligible news items
      const claimed = await this.claimEligibleNews();

      if (claimed.length === 0) {
        logger.info('No eligible news items to publish');
        return;
      }

      logger.info('Claimed news items for publishing', { count: claimed.length, ids: claimed.map((n) => n.id) });

      // Step 3: Process each claimed item (sequentially to respect rate limits)
      for (const news of claimed) {
        await this.processNewsItem(news);
      }

      logger.info('Social publisher run completed', { processed: claimed.length });
    } catch (error) {
      logger.error('Social publisher run encountered a fatal error', error);
      throw error;
    }
  }

  /**
   * Releases stale locks: if a news item has been locked for longer than
   * staleLockThresholdMs, it means the previous run crashed mid-processing.
   * We reset the lock so it can be picked up on the next run.
   */
  private async releaseStaleLocks(): Promise<void> {
    const staleThreshold = new Date(Date.now() - config.publisher.staleLockThresholdMs);

    const result = await prisma.news.updateMany({
      where: {
        socialProcessing: true,
        socialProcessingAt: {
          lt: staleThreshold,
        },
      },
      data: {
        socialProcessing: false,
        socialProcessingAt: null,
        socialError: 'Lock released due to stale processing state',
      },
    });

    if (result.count > 0) {
      logger.warn('Released stale processing locks', {
        count: result.count,
        staleThresholdMs: config.publisher.staleLockThresholdMs,
      });
    }
  }

  /**
   * Atomically claims eligible news items using an UPDATE ... WHERE pattern.
   *
   * "Eligible" means:
   *   - active = true
   *   - socialEnabled = true
   *   - socialProcessing = false (not currently being processed)
   *   - At least one platform has NOT been posted yet
   *   - socialRetryCount < maxRetries (don't retry items that exceeded limit)
   *
   * We claim in two DB operations:
   *   1. Find eligible IDs
   *   2. Atomically set socialProcessing=true WHERE id IN (...) AND socialProcessing=false
   *
   * Only rows where we win the race (updateMany count matches) are processed.
   * This is safe for concurrent processes — the WHERE condition is the lock guard.
   */
  private async claimEligibleNews(): Promise<News[]> {
    // Find candidates
    const candidates = await prisma.news.findMany({
      where: {
        active: true,
        socialEnabled: true,
        socialProcessing: false,
        socialRetryCount: { lt: config.publisher.maxRetries },
        OR: [
          { postedFacebook: false },
          { postedInstagram: false },
          { postedThreads: false },
        ],
      },
      orderBy: { publishedAt: 'desc' },
      take: config.publisher.batchSize,
      select: { id: true },
    });

    if (candidates.length === 0) return [];

    const candidateIds = candidates.map((n) => n.id);
    const now = new Date();

    // Atomically lock — only rows still unlocked will be updated
    await prisma.news.updateMany({
      where: {
        id: { in: candidateIds },
        socialProcessing: false, // Race condition guard
      },
      data: {
        socialProcessing: true,
        socialProcessingAt: now,
      },
    });

    // Fetch the rows we successfully locked
    // (some may have been taken by a concurrent process)
    return prisma.news.findMany({
      where: {
        id: { in: candidateIds },
        socialProcessing: true,
        socialProcessingAt: now,
      },
    });
  }

  /**
   * Processes a single news item: builds payload, calls each platform,
   * and updates DB results independently per platform.
   */
  private async processNewsItem(news: News): Promise<PublishResult> {
    const logCtx = {
      newsId: news.id,
      headline: news.headlineVi?.substring(0, 60) ?? "NO_HEADLINE"
    };
    logger.info('Processing news item', logCtx);

    const newsRecord: NewsRecord = {
      id: news.id,
      headlineVi: news.headlineVi  ?? "NO_HEADLINE",
      shortVi: news.shortVi,
      detailLink: news.detailLink,
      postedFacebook: news.postedFacebook,
      postedInstagram: news.postedInstagram,
      postedThreads: news.postedThreads,
      socialRetryCount: news.socialRetryCount,
      publishedAt: news.publishedAt,
    };

    // Build the publish payload
    // IMAGE STRATEGY: In production, inject your OG image scraper here.
    // For now, imageUrl is undefined unless you extend this with scraping logic.
    const imageUrl = await this.resolveImageUrl(news.detailLink);
    const payload: PublishPayload = { news: newsRecord, imageUrl };

    const results: PlatformResult[] = [];

    // --- Facebook ---
    if (!news.postedFacebook) {
      const fbResult = await this.facebook.post(payload);
      results.push(fbResult);
      await this.updatePlatformResult(news.id, 'facebook', fbResult);
    } else {
      logger.debug('Skipping Facebook (already posted)', logCtx);
      results.push({ platform: 'facebook', success: true, skipped: true });
    }

    // --- Instagram ---
    if (!news.postedInstagram) {
      const igResult = await this.instagram.post(payload);
      results.push(igResult);
      await this.updatePlatformResult(news.id, 'instagram', igResult);
    } else {
      logger.debug('Skipping Instagram (already posted)', logCtx);
      results.push({ platform: 'instagram', success: true, skipped: true });
    }

    // --- Threads ---
    // if (!news.postedThreads) {
    //   const thResult = await this.threads.post(payload);
    //   results.push(thResult);
    //   await this.updatePlatformResult(news.id, 'threads', thResult);
    // } else {
    //   logger.debug('Skipping Threads (already posted)', logCtx);
    //   results.push({ platform: 'threads', success: true, skipped: true });
    // }

    // --- Finalize the news record ---
    await this.finalizeNewsRecord(news.id, results);

    const allSucceeded = results.every((r) => r.success || r.skipped);
    const partialSuccess = results.some((r) => r.success && !r.skipped);

    const publishResult: PublishResult = {
      newsId: news.id,
      results,
      allSucceeded,
      partialSuccess,
    };

    logger.info('News item processing complete', {
      ...logCtx,
      allSucceeded,
      partialSuccess,
      platforms: results.map((r) => ({
        platform: r.platform,
        success: r.success,
        skipped: r.skipped,
        postId: r.postId,
      })),
    });

    return publishResult;
  }

  /**
   * Updates a single platform's result in the DB immediately after posting.
   * This is done independently per platform so partial failures are persisted.
   */
  private async updatePlatformResult(
    newsId: number,
    platform: 'facebook' | 'instagram' | 'threads',
    result: PlatformResult
  ): Promise<void> {
    try {
      if (platform === 'facebook') {
        await prisma.news.update({
          where: { id: newsId },
          data: result.success
            ? { postedFacebook: true, facebookPostId: result.postId }
            : { socialError: result.error?.substring(0, 2000) },
        });
      } else if (platform === 'instagram') {
        if (result.skipped && !result.success) {
          // Skipped due to no image — record the reason but don't mark as failure
          await prisma.news.update({
            where: { id: newsId },
            data: { socialError: result.error?.substring(0, 2000) },
          });
        } else {
          await prisma.news.update({
            where: { id: newsId },
            data: result.success
              ? { postedInstagram: true, instagramMediaId: result.postId }
              : { socialError: result.error?.substring(0, 2000) },
          });
        }
      } else if (platform === 'threads') {
        await prisma.news.update({
          where: { id: newsId },
          data: result.success
            ? { postedThreads: true, threadsPostId: result.postId }
            : { socialError: result.error?.substring(0, 2000) },
        });
      }
    } catch (dbError) {
      // Never let a DB write failure crash the pipeline for other platforms
      logger.error('Failed to persist platform result to DB', dbError, { newsId, platform });
    }
  }

  /**
   * After all platforms are attempted, release the processing lock
   * and update aggregate fields (socialPostedAt, socialRetryCount).
   */
  private async finalizeNewsRecord(newsId: number, results: PlatformResult[]): Promise<void> {
    const hasAnyFailure = results.some((r) => !r.success && !r.skipped);

    // Re-fetch current retry count to avoid overwriting concurrent changes
    const current = await prisma.news.findUnique({
      where: { id: newsId },
      select: { socialRetryCount: true, postedFacebook: true, postedInstagram: true, postedThreads: true },
    });

    if (!current) {
      logger.error('Could not find news item during finalization', undefined, { newsId });
      return;
    }

    const allDone = current.postedFacebook && current.postedInstagram && current.postedThreads;

    await prisma.news.update({
      where: { id: newsId },
      data: {
        socialProcessing: false,
        socialProcessingAt: null,
        socialRetryCount: hasAnyFailure ? current.socialRetryCount + 1 : current.socialRetryCount,
        socialPostedAt: allDone ? new Date() : undefined,
        // Clear error if everything succeeded
        socialError: !hasAnyFailure ? null : undefined,
      },
    });
  }

  /**
   * IMAGE RESOLUTION STRATEGY
   *
   * Current: Returns undefined (no image scraping implemented).
   *
   * Production upgrade path:
   *   1. Use axios to fetch the detailLink URL
   *   2. Parse the HTML for og:image meta tag
   *   3. Validate the image URL is accessible (HEAD request)
   *   4. Cache the resolved URL in the News record (add imageUrl field to schema)
   *
   * For now: Instagram falls back to INSTAGRAM_FALLBACK_IMAGE_URL .env var.
   * Threads works without an image (TEXT type).
   */
  private async resolveImageUrl(detailLink: string): Promise<string | undefined> {
    // TODO: Implement OG image scraping
    // Example:
    //   const html = await axios.get(detailLink, { timeout: 5000 });
    //   const match = html.data.match(/<meta property="og:image" content="([^"]+)"/);
    //   return match?.[1] ?? undefined;
    void detailLink;
    return undefined;
  }
}
