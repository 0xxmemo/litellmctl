#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Full host bootstrap for the AWS EC2 deployment.
#
# Runs once from user-data on first boot, AND again on every deploy via
# SSM (`git pull && bash bin/bootstrap-instance.sh`). Every step checks
# the current state before doing anything, so re-runs are safe and any
# mid-flow failure can be fixed forward — no CloudFormation teardown,
# no instance replacement.
#
# Inputs come from /home/ec2-user/.litellm/.env, which user-data seeds
# from CloudFormation parameters on first boot. Required:
#   LITELLM_MASTER_KEY      — any long secret
#   GATEWAY_ADMIN_EMAILS    — comma-separated admin emails
# Optional:
#   GATEWAY_PROTON_EMAIL, GATEWAY_PROTON_USERNAME,
#   GATEWAY_PROTON_PASSWORD, GATEWAY_PROTON_2FA_SECRET
#   SWAP_SIZE_GB            — default 32
#   CADDY_VERSION           — default 2.8.4
#
# Logs go to /var/log/bootstrap-instance.log for post-hoc debugging via
# SSM Session Manager.
# ---------------------------------------------------------------------------
set -eux
exec > >(tee -a /var/log/bootstrap-instance.log) 2>&1

readonly APP_USER=ec2-user
readonly LITELLM_DIR=/home/${APP_USER}/.litellm
readonly ENV_FILE=${LITELLM_DIR}/.env

# Source the deploy env if it's been seeded. On very first boot .env
# hasn't been written yet and user-data will seed it BEFORE calling this
# script — so if we got here with a missing .env, fail loudly.
if [ ! -f "$ENV_FILE" ]; then
  echo "[bootstrap] ${ENV_FILE} does not exist — user-data should have created it."
  echo "[bootstrap] aborting."
  exit 1
fi
set -a; . "$ENV_FILE"; set +a

readonly SWAP_SIZE_GB=${SWAP_SIZE_GB:-32}
readonly CADDY_VERSION=${CADDY_VERSION:-2.8.4}

# ── 1. System packages ──────────────────────────────────────────────────
# --allowerasing handles AL2023's pre-installed curl-minimal vs curl
# conflict that blocks install.sh's `curl | bash` sub-installers.
dnf install -y --allowerasing \
  git jq unzip \
  python3-pip python3-devel \
  gcc gcc-c++ make \
  sqlite sqlite-devel \
  golang \
  nodejs npm   # needed by node-gyp for the node-pty native addon the admin console relies on

# ── 2. Swap file ────────────────────────────────────────────────────────
# fallocate reserves extents without writing zeros — instant on ext4/xfs
# and safe for swap on a freshly-provisioned EBS volume (EBS is zeroed
# by AWS before attach). Saves ~4 min vs `dd if=/dev/zero` on 32 GB.
if [ ! -f /swapfile ]; then
  fallocate -l "${SWAP_SIZE_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ── 3. EBS data volume mounted at ${LITELLM_DIR} ────────────────────────
# The volume is created by CloudFormation. If the instance is re-created
# and the old volume is re-attached, this block is a no-op. If the volume
# is blank, we format it with LABEL=litellm-data.
DEV=/dev/nvme1n1
[ -b "$DEV" ] || DEV=/dev/xvdf
if ! blkid "$DEV" >/dev/null 2>&1; then
  mkfs.ext4 -L litellm-data "$DEV"
fi
mkdir -p "$LITELLM_DIR"
grep -q 'LABEL=litellm-data' /etc/fstab || \
  echo "LABEL=litellm-data ${LITELLM_DIR} ext4 defaults,nofail 0 2" >> /etc/fstab
mountpoint -q "$LITELLM_DIR" || mount -a
chown -R ${APP_USER}:${APP_USER} "$LITELLM_DIR"

# ── 4. Bun (per-user install) ───────────────────────────────────────────
sudo -u ${APP_USER} -H bash -lc 'command -v bun || curl -fsSL https://bun.sh/install | bash'

# ── 5. Claude Code (per-user native installer) ──────────────────────────
sudo -u ${APP_USER} -H bash -lc 'command -v claude || curl -fsSL https://claude.ai/install.sh | bash'

# ── 6. Caddy static binary ──────────────────────────────────────────────
if ! command -v caddy >/dev/null 2>&1; then
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_arm64.tar.gz" \
    | tar -C /usr/local/bin -xz caddy
  chmod +x /usr/local/bin/caddy
fi

# ── 7. install.sh — idempotent submodule + venv + litellm[proxy] install
sudo -u ${APP_USER} -H bash -lc "cd ${LITELLM_DIR} && bash install.sh"

# ── 8. litellmctl install — gateway + hydroxide (idempotent) ────────────
sudo -u ${APP_USER} -H bash -lc \
  "cd ${LITELLM_DIR} && ./bin/litellmctl install --with-gateway --with-protonmail"

# Force node-pty's install script so the admin console's PTY works.
# trustedDependencies in gateway/package.json tells bun to run it, but
# we call bun install a second time with --force to trigger the rebuild
# on re-runs in case the previous install was skipped (trusted list
# wasn't there yet).
sudo -u ${APP_USER} -H bash -lc \
  "cd ${LITELLM_DIR}/gateway && bun install"

# ── 9. Auto-auth hydroxide if Proton creds are in .env ──────────────────
# litellmctl auth protonmail sees GATEWAY_PROTON_PASSWORD and drives the
# non-interactive pty flow. Bridge password is saved back to .env.
if [ -n "${GATEWAY_PROTON_PASSWORD:-}" ]; then
  sudo -u ${APP_USER} -H bash -lc \
    "cd ${LITELLM_DIR} && ./bin/litellmctl auth protonmail" || true
fi

# ── 10. Services — start if stopped, restart if already running ─────────
# restart is idempotent and ensures running services pick up any code or
# .env changes from the deploy.
for svc in proxy gateway protonmail; do
  sudo -u ${APP_USER} -H bash -lc \
    "cd ${LITELLM_DIR} && ./bin/litellmctl restart ${svc}" \
    || sudo -u ${APP_USER} -H bash -lc \
       "cd ${LITELLM_DIR} && ./bin/litellmctl start ${svc}" \
    || true
done

# ── 11. Caddy — default Caddyfile + systemd unit ────────────────────────
readonly CADDYFILE=${LITELLM_DIR}/Caddyfile
if [ ! -f "$CADDYFILE" ]; then
  cat > "$CADDYFILE" <<'CADDY'
# Default Caddyfile — proxies all :80 traffic to the gateway.
# Replace the `:80` block with `your.domain.com { reverse_proxy localhost:14041 }`
# for automatic HTTPS, then: sudo systemctl reload caddy
:80 {
  reverse_proxy localhost:14041
}
CADDY
  chown ${APP_USER}:${APP_USER} "$CADDYFILE"
fi

cat > /etc/systemd/system/caddy.service <<UNIT
[Unit]
Description=Caddy reverse proxy
After=network.target

[Service]
User=${APP_USER}
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=/usr/local/bin/caddy run --config ${CADDYFILE} --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config ${CADDYFILE} --adapter caddyfile
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now caddy.service
systemctl reload caddy.service || systemctl restart caddy.service

# Breadcrumb — SSM wait loop in the deploy workflow keys off this file.
date -u +%FT%TZ > /var/log/user-data-done
echo "[bootstrap] complete"
