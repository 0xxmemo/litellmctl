# Deploying LiteLLM Gateway on AWS

One ARM Graviton EC2 instance running the same code as a VPC / laptop
install. No Docker, no image registry. Everything is provisioned by
CloudFormation and configured by `install.sh` — the same script that
powers the host install path. Deploys after the first are a one-liner
SSM exec of `git pull && litellmctl restart`.

## What you end up with

- One `c7g.medium` EC2 (1 vCPU / 2 GB / 120 GB gp3 root / 32 GB swap)
- Stable Elastic IP
- Ports `80`, `443`, `14041` open; Caddy handles the first two
- Systemd-managed services: LiteLLM proxy, bun gateway, hydroxide
  (ProtonMail bridge), Caddy
- Auto-deploy on every published GitHub Release from `main`

Running cost: **~$30–40/month** on-demand (c7g.medium ≈ $26/mo + 120 GB
gp3 root ≈ $10/mo). Local embedding/transcription are off by default —
if you opt in, bump to `c7g.xlarge` or larger (see "Need to resize the
instance" below); cost there is closer to $80–100/month.

## Prerequisites

1. **An AWS account.** Free tier is fine; you pay for the EC2 + EBS only.
2. **AWS CLI** and **GitHub CLI** installed locally. The onboarding CLI
   prompts to run `aws configure` / `gh auth login` inline if either isn't
   authenticated.
3. **A GitHub fork** of this repo.

## Onboarding — one command

```bash
cd ~/.litellm
./bin/litellmctl deploy aws
```

The CLI walks you through everything interactively:

1. Verifies `aws` + `gh` + `git` are installed and authenticated.
2. Auto-discovers your GitHub org/repo from the remote and your email
   from `git config`.
3. Prompts for region, stack name, admin emails, optionally ProtonMail
   creds.
4. Detects any pre-existing GitHub OIDC provider in the account and
   reuses it (AWS only allows one per issuer URL).
5. Deploys the OIDC CloudFormation stack → outputs the deploy-role ARN.
6. Generates a `LITELLM_MASTER_KEY` and pushes all secrets to the repo
   via `gh secret set`.
7. Offers to dispatch the `deploy` workflow against your current branch
   for a test deploy.

Safe to re-run — every step is idempotent.

## What the workflow does

```
┌─ deploy.yml ───────────────────────────────────────────┐
│                                                        │
│  1. Validate required secrets                          │
│  2. Configure AWS creds (OIDC)                         │
│  3. Recover wedged stack (if any)                      │
│  4. CloudFormation deploy (no-op when nothing changed) │
│  5. SSM: git pull && litellmctl restart                │
│  6. Smoke-test /api/health                             │
│  7. Print summary (public IP, ref)                     │
│                                                        │
└────────────────────────────────────────────────────────┘
```

First run: ~5 minutes (EC2 launch + `install.sh` + systemd services).
Subsequent runs: **~30 seconds** — the CFN step is a no-op, and the SSM
step just fetches and restarts.

## Triggering a deploy

- **Published GitHub Releases** cut from `main` — the production path.
  Releases from any other branch are ignored.
  ```bash
  git tag v0.1.0 && git push origin v0.1.0
  gh release create v0.1.0 --generate-notes
  ```
- **Manual `workflow_dispatch`** — `gh workflow run deploy.yml -r <branch>`.
  Works on any branch that has `.github/workflows/deploy.yml` committed.
  Useful for ad-hoc testing or a hotfix deploy without tagging.

Branch pushes are intentionally NOT a trigger — iterate as much as you
want without any AWS churn.

## What lives where on the instance

Everything the VPC install uses, same layout:

```
/home/ec2-user/.litellm/       (EBS data volume)
├── .env                       API keys, LITELLM_MASTER_KEY, proton creds
├── config.yaml                Proxy routing (created by the wizard)
├── auth.*.json                OAuth tokens per provider
├── gateway/gateway.db         SQLite: users, keys, usage, vectors
├── plugins/                   User-installed gateway plugins
├── Caddyfile                  Reverse proxy config
├── logs/                      proxy.log, gateway.log, ...
├── venv/                      Python venv
└── .git/                      Git repo — `git pull` updates the code
```

Because the EBS volume is mounted directly at `~/.litellm`, **the repo
itself lives on the persistent volume**. Instance replacement never
loses state. `git pull && litellmctl restart` is the entire deploy loop.

**`.env` is admin-owned.** On first boot the pipeline seeds `.env` from
CloudFormation parameters (which come from your GitHub secrets). After
that, the instance's `.env` is the source of truth — the deploy pipeline
only *adds* missing keys, never overwrites existing ones. So you can
edit `.env` from the admin web console (e.g. to rotate
`LITELLM_MASTER_KEY` or tweak `GATEWAY_ADMIN_EMAILS`) and your changes
survive every subsequent deploy. To reset a value *from* the pipeline,
delete its line from `.env` and re-deploy — the next run re-seeds it
from SSM Parameter Store.

## Admin console

The gateway's `/console` route is a full bash PTY into the EC2 instance,
admin-only. Runs as `ec2-user`, sees the real systemd, the real `.env`,
the real `litellmctl` binary. Anything you'd do over SSH, you can do in
the browser.

Installed + pre-wired:

- `litellmctl` — proxy/gateway lifecycle, wizard, provider auth
- `claude` — Claude Code, aliased to `--dangerously-skip-permissions`
  and pointed at the local LiteLLM proxy via `ANTHROPIC_BASE_URL`
- `caddy`, `bun`, `hydroxide`, `ollama` (if installed)

## Day-2 operations (from the web console)

| Task                         | Command                                                    |
|------------------------------|-------------------------------------------------------------|
| Create `config.yaml`         | `litellmctl wizard`                                         |
| Log into a provider          | `litellmctl auth chatgpt` (or gemini, qwen, kimi)          |
| Restart services             | `litellmctl restart proxy gateway`                          |
| Ask Claude Code for help     | `claude`                                                    |
| Tail logs                    | `litellmctl logs gateway`                                   |
| Add a local embedding model  | `litellmctl install --with-local && litellmctl start embedding` |
| Read an OTP from logs        | `journalctl --user -u litellm-gateway -f \| grep -i 'OTP CODE'` |

## Add a domain + HTTPS

From the admin console, edit the Caddyfile:

```bash
cat > /home/ec2-user/.litellm/Caddyfile <<'CADDY'
your.domain.com {
  reverse_proxy localhost:14041
}
CADDY
sudo systemctl reload caddy
```

Point an A record at the EIP — Caddy gets a Let's Encrypt cert
automatically. `https://your.domain.com` is now the entry point.

## ProtonMail for OTP emails

If you set `GATEWAY_PROTON_EMAIL`, `GATEWAY_PROTON_USERNAME`,
`GATEWAY_PROTON_PASSWORD`, and (optionally) `GATEWAY_PROTON_2FA_SECRET`
as GitHub secrets during onboarding, user-data will:

1. Install hydroxide (the Go-based SMTP bridge).
2. Run `litellmctl auth protonmail` — the CLI's non-interactive pty flow
   uses the creds + TOTP, captures the bridge password, and saves it
   to `.env`.
3. Start the hydroxide bridge on `127.0.0.1:1025`.

If you don't set them, the gateway logs OTP codes to the journal and
admins read them from the web console on first login:

```bash
journalctl --user -u litellm-gateway --since="5 min ago" | grep -i 'OTP CODE'
```

## Troubleshooting

**Workflow fails at "Deploy CloudFormation stack".** The
**On-failure stack diagnostics** step dumps the failing resources into
the job summary — look there first. Common causes:

- Missing IAM permission on the deploy role (the `aws/bootstrap-github-oidc.yml`
  role is broad — `cloudformation:* ec2:* iam:* ssm:* logs:*`. If you've
  tightened it, a new CFN resource type may need a new permission).
- A stale main-stack in a terminal state (`ROLLBACK_COMPLETE`,
  `REVIEW_IN_PROGRESS`, etc.). The workflow auto-recovers these by
  deleting and re-creating; check the "Recover wedged stack if needed"
  step output.

**`/api/health` times out.** SSM into the instance:

```bash
aws ssm start-session --target $(aws cloudformation describe-stacks \
  --stack-name litellm-gateway \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text)
```

Then: `cat /var/log/user-data.log` for first-boot issues,
`journalctl --user -u litellm-proxy -u litellm-gateway --since="10 min ago"`
for service logs.

**Need to resize the instance.** Re-run the workflow via
`workflow_dispatch` with the `instance_type` input set to a different
value, or edit the default in `aws/cloudformation.yml`. CloudFormation
handles the resize with brief downtime. Common ramps from the
`c7g.medium` default:

- `c7g.large` (2 vCPU / 4 GB) — extra headroom for heavier proxy traffic
- `c7g.xlarge` (4 vCPU / 8 GB) — required if you re-enable local Ollama
  embeddings or whisper transcription
- `c7g.2xlarge` (8 vCPU / 16 GB) — bigger still

## Teardown

```bash
aws cloudformation delete-stack --stack-name litellm-gateway
aws cloudformation wait stack-delete-complete --stack-name litellm-gateway

# And the OIDC stack (one-time bootstrap)
aws cloudformation delete-stack --stack-name litellm-gateway-oidc
```

The EBS data volume has `DeleteOnTermination: false` — it survives stack
deletion. Delete it manually if you want to wipe state:

```bash
aws ec2 delete-volume --volume-id $(aws ec2 describe-volumes \
  --filters "Name=tag:Name,Values=litellm-gateway" \
  --query 'Volumes[0].VolumeId' --output text)
```
