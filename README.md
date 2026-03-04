# Social Auto Publisher

Production-grade multi-platform social media auto-publisher.
Posts to Facebook, Instagram, and Threads from a PostgreSQL-backed News table.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   Cron / systemd Timer                   │
│              (every 5 minutes via timer unit)            │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│              social-publish.job.ts (Entry Point)         │
│  - Validates env config                                  │
│  - Bootstraps service                                    │
│  - Handles process signals                               │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│           SocialPublisherService (Orchestrator)          │
│                                                          │
│  1. releaseStaleLocks()   → Reset crashed process locks  │
│  2. claimEligibleNews()   → Atomic lock via updateMany   │
│  3. processNewsItem()     → Per-item pipeline            │
│     ├─ FacebookService.post()                            │
│     ├─ InstagramService.post()  (2-phase: create+publish)│
│     └─ ThreadsService.post()   (2-phase: create+publish) │
│  4. updatePlatformResult() → Per-platform DB write       │
│  5. finalizeNewsRecord()  → Release lock + counters      │
└─────────────────────────────────────────────────────────┘
                        │
              ┌─────────┼──────────┐
              ▼         ▼          ▼
        Facebook    Instagram   Threads
        Graph API   Graph API   Graph API
        (v19.0)     (v19.0)     (v1.0)
```

---

## Concurrency Safety Model

### Atomic Claiming Pattern

The system uses a two-step atomic claim pattern safe for concurrent processes:

```typescript
// Step 1: Find candidate IDs (read)
const candidates = await prisma.news.findMany({
  where: { active: true, socialEnabled: true, socialProcessing: false, ... },
  select: { id: true },
});

// Step 2: Atomically lock (write with WHERE guard)
// Only rows where socialProcessing=false at write time are locked.
// PostgreSQL row-level locking ensures correctness under concurrent writers.
await prisma.news.updateMany({
  where: { id: { in: candidateIds }, socialProcessing: false },
  data: { socialProcessing: true, socialProcessingAt: now },
});

// Step 3: Only process rows WE locked
const locked = await prisma.news.findMany({
  where: { id: { in: candidateIds }, socialProcessing: true, socialProcessingAt: now },
});
```

**Why this works:** Even if two cron processes run simultaneously and both see the same candidates in Step 1, PostgreSQL's row-level locking means only one UPDATE wins per row. Step 3 then fetches only the rows that process actually locked (matched by the exact timestamp).

### Stale Lock Recovery

If a process crashes while holding a lock, the next run detects rows where `socialProcessingAt < now - threshold` and releases them, making them eligible again.

---

## Platform Implementation Details

### Facebook
- Single API call: `POST /{page_id}/feed`
- Includes `link` field for OG card preview
- Character limit: 63,206
- Non-retryable codes: 190 (invalid token), 200 (permissions), 10, 4, 17

### Instagram
Two-phase flow (required by Graph API):
1. `POST /{account_id}/media` → creates async container, returns container ID
2. Poll `GET /{container_id}?fields=status_code` until `FINISHED`
3. `POST /{account_id}/media_publish` → publishes, returns media ID

**Image requirement:** Instagram CANNOT post text-only. Options:
- Configure `INSTAGRAM_FALLBACK_IMAGE_URL` with a branded image
- Implement OG scraper in `resolveImageUrl()` method
- Skip Instagram if no image (logged as skipped, not failed)

### Threads
Two-phase flow (same infrastructure as Instagram):
1. `POST /{user_id}/threads` with `media_type=TEXT|IMAGE`
2. Poll container status
3. `POST /{user_id}/threads_publish`

Threads supports TEXT-only posts, so it will always attempt even without an image.

---

## Rate Limit Strategy

| Platform | Limit | Our Handling |
|----------|-------|--------------|
| Facebook | 200 calls/hour/token | Batch size 5, cron every 5min → well within limits |
| Instagram | 25 posts/day | Check `postedInstagram` flag prevents re-posts |
| Threads | 250 API calls/hour | Polling adds calls; monitor with `socialRetryCount` |

All platforms:
- `Retry-After` header is respected on 429 responses
- Exponential backoff with full jitter prevents thundering herd
- 3 retry max per item per run; items exceeding `maxRetries` are skipped

---

## Folder Structure

```
social-publisher/
├── prisma/
│   ├── schema.prisma              # Extended News model
│   └── migrations/
│       └── add_social_fields.sql  # Raw SQL migration
├── src/
│   ├── config/
│   │   └── env.ts                 # Validated env config (fails fast)
│   ├── jobs/
│   │   └── social-publish.job.ts  # Cron entry point
│   ├── prisma/
│   │   └── client.ts              # Singleton Prisma client
│   ├── services/
│   │   ├── platforms/
│   │   │   ├── facebook.service.ts
│   │   │   ├── instagram.service.ts
│   │   │   └── threads.service.ts
│   │   └── social-publisher.service.ts  # Orchestrator
│   ├── types/
│   │   └── index.ts               # Shared TypeScript types
│   └── utils/
│       ├── logger.ts              # Structured JSON logger
│       └── retry.ts               # Retry with exponential backoff
├── scripts/
│   ├── deploy.sh                  # Deployment automation
│   ├── social-publisher.service   # systemd service unit
│   └── social-publisher.timer    # systemd timer unit
├── logs/                          # Daily rotating log files
├── dist/                          # Compiled JS output
├── ecosystem.config.js            # PM2 configuration
├── env.example                    # Environment variable template
├── package.json
└── tsconfig.json
```

---

## Deployment

### Prerequisites
- Node.js >= 18
- PostgreSQL >= 14
- A dedicated non-root Linux user (e.g. `appuser`)

### Option A: PM2

```bash
# Install PM2 globally
npm install -g pm2

# Build the project
npm run build:clean

# Run Prisma migrations
npx prisma migrate deploy

# Start with PM2 (cron mode)
pm2 start ecosystem.config.js --.env production

# Save PM2 process list (survives reboots)
pm2 save
pm2 startup  # Follow the printed command to install startup hook

# Monitor
pm2 logs social-publisher
pm2 monit
```

### Option B: systemd (Recommended for Production)

```bash
# Run the deployment script (as root)
chmod +x scripts/deploy.sh
sudo ./scripts/deploy.sh /opt/social-publisher

# Verify timer is running
systemctl status social-publisher.timer
systemctl list-timers | grep social

# View logs
journalctl -u social-publisher -f --output=json-pretty
```

### Option C: Raw Cron (Minimal Setup)

```bash
# Build
npm run build

# Add to crontab (as appuser)
crontab -e

# Add:
*/5 * * * * cd /opt/social-publisher && /usr/bin/node dist/jobs/social-publish.job.js >> /opt/social-publisher/logs/cron.log 2>&1
```

---

## Security Best Practices

### Token Management
- Access tokens live ONLY in `.env` (mode 600, owned by service user)
- Logger's `redactSensitive()` strips any key matching `/token|secret|password|authorization/i`
- Tokens are never logged, not even partially
- Rotate tokens via Meta's Token Debugger before expiry

### Database Security
- Use a dedicated PostgreSQL role with ONLY SELECT/UPDATE/INSERT on the `news` table
- No DROP, TRUNCATE, CREATE privileges for the app user
- Connection string uses `connection_limit=5` to prevent pool exhaustion

```sql
-- Create restricted DB user
CREATE USER social_publisher_user WITH PASSWORD 'STRONG_PASSWORD';
GRANT SELECT, INSERT, UPDATE ON TABLE news TO social_publisher_user;
```

### System Security
- Run as `appuser` (non-root, no shell)
- systemd `NoNewPrivileges=true`, `ProtectSystem=strict`
- `ReadWritePaths` limited to the logs directory
- No outbound ports beyond 443 (HTTPS to Meta APIs)

### Token Refresh Strategy
Meta access tokens expire. Implement a monitoring cron that:
1. Calls `GET /debug_token` to check expiry
2. Alerts via Slack/email 7 days before expiry
3. Uses long-lived page tokens (60-day) + automated refresh

---

## Monitoring & Alerting

### Log Structure
Every log line is JSON with:
```json
{
  "timestamp": "2024-01-15T08:30:00.000Z",
  "level": "info",
  "service": "SocialPublisherService",
  "message": "News item processing complete",
  "newsId": 1234,
  "allSucceeded": true,
  "platforms": [
    { "platform": "facebook", "success": true, "postId": "123_456" },
    { "platform": "instagram", "success": true, "postId": "789012" },
    { "platform": "threads", "success": true, "postId": "345678" }
  ]
}
```

### Key Metrics to Monitor
```sql
-- Items stuck in processing (stale locks)
SELECT COUNT(*) FROM news
WHERE "socialProcessing" = true
  AND "socialProcessingAt" < NOW() - INTERVAL '10 minutes';

-- Failed items (exceeded retry count)
SELECT COUNT(*) FROM news
WHERE "socialEnabled" = true
  AND "socialRetryCount" >= 3
  AND NOT ("postedFacebook" AND "postedInstagram" AND "postedThreads");

-- Publishing backlog
SELECT COUNT(*) FROM news
WHERE active = true AND "socialEnabled" = true
  AND "socialProcessing" = false
  AND ("postedFacebook" = false OR "postedInstagram" = false OR "postedThreads" = false);

-- Daily posting volume
SELECT DATE("socialPostedAt"), COUNT(*)
FROM news WHERE "socialPostedAt" IS NOT NULL
GROUP BY 1 ORDER BY 1 DESC;
```

### Grafana / Datadog Integration
Pipe log files to your log aggregator. Key alert conditions:
- `level=error` with `platform=facebook/instagram/threads` → PagerDuty
- `stale locks released` count > 0 → Slack warning
- `socialRetryCount >= 3` query returns > 10 rows → investigate

---

## Scalability Upgrade Path (Queue-Based Architecture)

The current cron-based design handles ~100-500 posts/day easily. When you need more:

### Phase 1: Redis-based Queue (Current → Next)
```
Replace: Cron polling DB
With:    BullMQ job queue backed by Redis

News is created → enqueue job → workers process independently
Enables: true parallelism, priority queues, delayed retries, dead-letter queue
```

### Phase 2: Horizontal Scaling
```
Multiple worker instances can safely process different jobs:
- BullMQ handles distributed locking per job
- Remove DB-level socialProcessing flag (queue is the lock)
- Each platform becomes a separate queue with its own concurrency settings
```

### Phase 3: Platform Rate Limit Queues
```typescript
// Each platform gets a rate-limited queue
const facebookQueue = new Queue('facebook', {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
  limiter: { max: 100, duration: 60 * 60 * 1000 }, // 100/hour
});
```

### Migration Path
1. Add `jobId` field to News model
2. Replace `claimEligibleNews()` with `enqueueNewsJob()`
3. Replace platform service calls with job producers
4. Add worker processes that consume from queues
5. Keep DB flags as audit trail, not locking mechanism

---

## Prisma Query Reference

```typescript
// Enable social publishing for a news item
await prisma.news.update({
  where: { id: newsId },
  data: { socialEnabled: true },
});

// Query items needing publishing (all platforms)
const pending = await prisma.news.findMany({
  where: {
    active: true,
    socialEnabled: true,
    socialProcessing: false,
    OR: [
      { postedFacebook: false },
      { postedInstagram: false },
      { postedThreads: false },
    ],
  },
  orderBy: { publishedAt: 'desc' },
});

// Reset a failed item for retry
await prisma.news.update({
  where: { id: newsId },
  data: {
    socialRetryCount: 0,
    socialError: null,
    postedFacebook: false,
    postedInstagram: false,
    postedThreads: false,
    socialProcessing: false,
  },
});

// Bulk enable social posting for recent news
await prisma.news.updateMany({
  where: {
    active: true,
    socialEnabled: false,
    publishedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  },
  data: { socialEnabled: true },
});
```
