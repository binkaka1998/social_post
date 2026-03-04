-- prisma/migrations/add_social_publisher_fields/migration.sql
-- Run via: npx prisma migrate deploy
-- Or apply manually if using raw SQL migrations.

-- Add social publishing fields to the news table
ALTER TABLE "news"
  ADD COLUMN IF NOT EXISTS "socialEnabled"      BOOLEAN   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "socialProcessing"   BOOLEAN   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "socialProcessingAt" TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS "postedFacebook"     BOOLEAN   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "postedInstagram"    BOOLEAN   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "postedThreads"      BOOLEAN   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "facebookPostId"     TEXT,
  ADD COLUMN IF NOT EXISTS "instagramMediaId"   TEXT,
  ADD COLUMN IF NOT EXISTS "threadsPostId"      TEXT,
  ADD COLUMN IF NOT EXISTS "socialError"        TEXT,
  ADD COLUMN IF NOT EXISTS "socialRetryCount"   INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "socialPostedAt"     TIMESTAMP WITH TIME ZONE;

-- Composite index for the main eligibility query
-- Covers: active=true, socialEnabled=true, socialProcessing=false, platform flags
CREATE INDEX IF NOT EXISTS "news_social_eligibility_idx"
  ON "news" ("active", "socialEnabled", "socialProcessing", "postedFacebook", "postedInstagram", "postedThreads");

-- Index for stale lock detection
CREATE INDEX IF NOT EXISTS "news_social_processing_at_idx"
  ON "news" ("socialProcessingAt")
  WHERE "socialProcessing" = true;
