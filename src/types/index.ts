// src/types/index.ts

export interface PlatformResult {
  platform: 'facebook' | 'instagram' | 'threads';
  success: boolean;
  postId?: string;
  error?: string;
  skipped?: boolean;
}

export interface PublishResult {
  newsId: number;
  results: PlatformResult[];
  allSucceeded: boolean;
  partialSuccess: boolean;
}

export interface NewsRecord {
  id: number;
  headlineVi: string | null;
  shortVi: string | null;
  detailLink: string;
  postedFacebook: boolean;
  postedInstagram: boolean;
  postedThreads: boolean;
  socialRetryCount: number;
  publishedAt: Date | null;
}

export interface PublishPayload {
  news: NewsRecord;
  text?: string;   // optional
  imageUrl?: string;
}

export type Platform = 'facebook' | 'instagram' | 'threads';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  factor: number;
}

export interface ApiError {
  statusCode?: number;
  message: string;
  isRetryable: boolean;
  platform: Platform;
}
