---
name: ssm-ops
description: Run ad-hoc shell commands on the production EC2 instance via AWS SSM (git pull, restart gateway, tail logs, hotfixes). Use when the user asks to "ssm", "run on the instance", "pull on remote", "restart gateway on prod", "check the server", or any remote-exec task that isn't a full release. Covers the gotchas (litellmctl PATH, systemd --user context, file:// parameters) learned the hard way.
---

# SSM Ops

Operate the production gateway without ssh or a full release.

## Deployment facts

- **Stack**: CloudFormation `litellm-gateway` in `us-east-1` (names come from the `APP_NAME` / `AWS_REGION` GitHub secrets but these are the current values).
- **Instance id**: read from stack output `InstanceId` — never hard-code it:

  ```bash
  aws cloudformation describe-stacks --stack-name litellm-gateway --region us-east-1 \
    --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' --output text
  ```

- **App root on the box**: `/home/ec2-user/.litellm` (owned by `ec2-user`, git-backed).
- **Service**: systemd **user** unit `litellm-gateway.service` managed by `ec2-user`'s user manager.
- **Health**: `http://<PublicIp>:14041/api/health` (also from stack outputs).
- **Secrets**: `/litellm-gateway/<KEY>` in SSM Parameter Store as SecureStrings; fetch with `--with-decryption`.

## The wrapper — use this by default

`scripts/ssm-run.sh` takes a shell script on stdin, submits it via `AWS-RunShellScript`, polls until done, and prints stdout/stderr + exits with the remote exit code.

```bash
# From repo root:
./.claude/skills/ssm-ops/scripts/ssm-run.sh <<'REMOTE'
set -eux
cd /home/ec2-user/.litellm
sudo -u ec2-user -H git fetch --prune origin
sudo -u ec2-user -H git pull --ff-only origin main
sudo -u ec2-user -H -i bash -c 'XDG_RUNTIME_DIR=/run/user/$(id -u) /home/ec2-user/.litellm/bin/litellmctl restart gateway'
REMOTE
```

Env overrides: `STACK_NAME`, `AWS_REGION`, `INSTANCE_ID` (skips the CFN lookup).

## Canonical snippets

### Pull latest + restart gateway

```bash
./.claude/skills/ssm-ops/scripts/ssm-run.sh <<'REMOTE'
set -eux
cd /home/ec2-user/.litellm
sudo -u ec2-user -H git fetch --prune origin
sudo -u ec2-user -H git checkout main
sudo -u ec2-user -H git pull --ff-only origin main
sudo -u ec2-user -H git submodule update --init --recursive
sudo -u ec2-user -H git log -1 --oneline
sudo -u ec2-user -H -i bash -c 'XDG_RUNTIME_DIR=/run/user/$(id -u) /home/ec2-user/.litellm/bin/litellmctl restart gateway'
REMOTE
```

### Gateway status / logs

```bash
./.claude/skills/ssm-ops/scripts/ssm-run.sh <<'REMOTE'
sudo -u ec2-user -H -i bash -c 'systemctl --user status litellm-gateway --no-pager --lines=30'
sudo -u ec2-user -H -i bash -c 'tail -n 80 /home/ec2-user/.litellm/logs/gateway.log'
sudo -u ec2-user -H -i bash -c 'tail -n 80 /home/ec2-user/.litellm/logs/gateway-error.log 2>/dev/null || true'
REMOTE
```

### Edit an env value and restart

```bash
./.claude/skills/ssm-ops/scripts/ssm-run.sh <<'REMOTE'
set -eux
ENV=/home/ec2-user/.litellm/.env
grep -q '^FOO=' "$ENV" && sudo -u ec2-user -H sed -i 's/^FOO=.*/FOO=bar/' "$ENV" \
  || echo 'FOO=bar' | sudo -u ec2-user -H tee -a "$ENV" >/dev/null
sudo -u ec2-user -H -i bash -c 'XDG_RUNTIME_DIR=/run/user/$(id -u) /home/ec2-user/.litellm/bin/litellmctl restart gateway'
REMOTE
```

### Health check from your laptop

```bash
IP=$(aws cloudformation describe-stacks --stack-name litellm-gateway --region us-east-1 \
      --query 'Stacks[0].Outputs[?OutputKey==`PublicIp`].OutputValue' --output text)
curl -sS --max-time 5 "http://${IP}:14041/api/health"
```

## Gotchas learned the hard way

1. **`litellmctl` is not on PATH in SSM contexts.** Neither the SSM document's default shell nor `sudo -u ec2-user -i` picks up the user's shell alias. Always call `/home/ec2-user/.litellm/bin/litellmctl` by absolute path.

2. **`systemctl --user` needs `XDG_RUNTIME_DIR`.** When running from SSM you're not attached to ec2-user's login session. Prefix any `systemctl --user …` or `litellmctl restart gateway` with `XDG_RUNTIME_DIR=/run/user/$(id -u)`.

3. **Run as ec2-user, not root.** The service lives under ec2-user's systemd --user manager. Use `sudo -u ec2-user -H -i bash -c '…'` so the correct manager is reachable and PATH is set up.

4. **`aws ssm send-command` needs `--parameters file://…`, not `--cli-input-json`.** The top-level `commands` field is rejected; wrap as `{"commands": ["<script>"]}` in a temp file. The wrapper handles this.

5. **`zsh` on macOS treats `status` as read-only.** If you copy a polling loop into a shell command, put it inside `bash -c '…'` or rename the variable. Multiple past agents tripped on this.

6. **Polling interval.** `ssm get-command-invocation` starts returning `Pending` then `InProgress`. Allow ~20–60s for anything that restarts the gateway (frontend rebuild is ~5s but systemctl start waits on health). The wrapper polls at 3s intervals up to 5 minutes.

7. **Restart fixed in `3c798fb`.** `gateway_restart()` now detaches into a transient systemd scope when invoked inside the gateway's own cgroup. You can safely call `litellmctl restart gateway` from the console pty or `/api/admin/restart` — but from SSM you're already outside the cgroup, so no detach is needed and no `logs/gateway-restart.log` will be written.

## Do not

- **Do not edit files via SSM that are also managed by CloudFormation / the deploy pipeline.** `install.sh --pipeline` and user-data own systemd units, caddy, nginx, etc. Drift gets clobbered on next deploy.
- **Do not `systemctl restart` the unit directly unless you know you don't need a frontend rebuild.** `litellmctl restart gateway` does `bun run build` first; plain `systemctl --user restart litellm-gateway` skips it and you'll serve a stale UI.
- **Do not print secret values to stdout.** SSM invocation output is stored in CloudTrail for 30 days. Use `>/dev/null 2>&1` when sourcing `.env` or fetching Parameter Store values.
