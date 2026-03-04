#!/usr/bin/.env bash
# scripts/deploy.sh
# Production deployment script for the Social Auto Publisher.
# Run as root or a user with sudo access.
# Usage: ./scripts/deploy.sh [/path/to/deploy]

set -euo pipefail

DEPLOY_DIR="${1:-/opt/social-publisher}"
SERVICE_USER="appuser"
NODE_MIN_VERSION="18"

echo "=== Social Auto Publisher Deployment ==="
echo "Deploy directory: $DEPLOY_DIR"

# -------------------------------------------------------
# 1. Check Node.js version
# -------------------------------------------------------
CURRENT_NODE=$(node --version | sed 's/v//' | cut -d. -f1)
if [ "$CURRENT_NODE" -lt "$NODE_MIN_VERSION" ]; then
  echo "ERROR: Node.js >= ${NODE_MIN_VERSION} required, found v${CURRENT_NODE}"
  exit 1
fi
echo "[OK] Node.js version: $(node --version)"

# -------------------------------------------------------
# 2. Create system user if not exists
# -------------------------------------------------------
if ! id "$SERVICE_USER" &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  echo "[OK] Created service user: $SERVICE_USER"
else
  echo "[OK] Service user exists: $SERVICE_USER"
fi

# -------------------------------------------------------
# 3. Create deploy directory and set permissions
# -------------------------------------------------------
mkdir -p "$DEPLOY_DIR/logs"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DEPLOY_DIR"
chmod 750 "$DEPLOY_DIR"
echo "[OK] Deploy directory prepared: $DEPLOY_DIR"

# -------------------------------------------------------
# 4. Install dependencies (as service user)
# -------------------------------------------------------
cd "$DEPLOY_DIR"
npm ci --production
echo "[OK] npm dependencies installed"

# -------------------------------------------------------
# 5. Generate Prisma client
# -------------------------------------------------------
npx prisma generate
echo "[OK] Prisma client generated"

# -------------------------------------------------------
# 6. Build TypeScript
# -------------------------------------------------------
npm run build
echo "[OK] TypeScript compiled to dist/"

# -------------------------------------------------------
# 7. Run database migrations
# -------------------------------------------------------
echo "Running database migrations..."
npx prisma migrate deploy
echo "[OK] Database migrations applied"

# -------------------------------------------------------
# 8. Protect the ..env file
# -------------------------------------------------------
if [ -f "$DEPLOY_DIR/.env" ]; then
  chown "$SERVICE_USER:$SERVICE_USER" "$DEPLOY_DIR/.env"
  chmod 600 "$DEPLOY_DIR/.env"
  echo "[OK] .env file permissions secured (600)"
else
  echo "WARNING: .env file not found at $DEPLOY_DIR/.env"
  echo "  Copy env.example to .env and fill in your values before starting the service."
fi

# -------------------------------------------------------
# 9. Install and enable systemd units (optional)
# -------------------------------------------------------
if command -v systemctl &>/dev/null; then
  cp "$DEPLOY_DIR/scripts/social-publisher.service" /etc/systemd/system/
  cp "$DEPLOY_DIR/scripts/social-publisher.timer" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable social-publisher.timer
  systemctl start social-publisher.timer
  echo "[OK] systemd timer installed and started"
  echo "  Check status: systemctl status social-publisher.timer"
  echo "  View logs:    journalctl -u social-publisher -f"
else
  echo "[SKIP] systemctl not found — manual scheduling required"
fi

echo ""
echo "=== Deployment complete ==="
echo ""
echo "Next steps:"
echo "  1. Ensure .env is configured at: $DEPLOY_DIR/.env"
echo "  2. Verify DB connection: npx prisma db pull"
echo "  3. Check timer status: systemctl list-timers | grep social"
echo "  4. Watch logs: journalctl -u social-publisher -f"
echo "  OR with PM2: pm2 start ecosystem.config.js --env production"
