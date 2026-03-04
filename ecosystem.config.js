// ecosystem.config.js
// PM2 process configuration for the Social Auto Publisher.
// Run with: pm2 start ecosystem.config.js --.env production

module.exports = {
  apps: [
    {
      name: 'social-publisher',
      script: 'dist/jobs/social-publish.job.js',
      interpreter: 'node',
      interpreter_args: '--max-old-space-size=256',

      // Run as a cron job (every 5 minutes)
      // PM2 will spawn the process, run it, then it exits.
      // Set cron_restart to your desired interval.
      cron_restart: '*/5 * * * *',

      // Don't auto-restart after normal exit (exit code 0)
      // The cron handles re-scheduling.
      autorestart: false,

      // Restart on crash (exit code != 0)
      // PM2 will still restart if the process crashes unexpectedly
      watch: false,

      // Environment variables loaded from ..env via dotenv in the app itself
      // Do NOT put secrets in ecosystem.config.js
      env_production: {
        NODE_ENV: 'production',
      },

      // Log configuration
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Max log size before rotation (requires pm2-logrotate module)
      max_memory_restart: '256M',

      // Instance settings
      instances: 1, // Single instance for cron mode (locking handles concurrency)
      exec_mode: 'fork',
    },
  ],
};
