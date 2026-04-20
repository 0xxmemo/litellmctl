# Deploying LiteLLM Gateway on AWS

Click-by-click walkthrough that assumes **no prior AWS knowledge**. Total
hands-on time: ~10 minutes. After that, every `git push` auto-deploys.

## What you end up with

- One ARM Graviton EC2 instance (`c7g.xlarge` — 4 vCPU / 8 GB / 120 GB EBS / 32 GB swap)
- A stable public IP (Elastic IP)
- Ports `80`, `443`, `14041` open; Caddy handles the first two once you point a domain at it
- Automatic rollout on every push to `main`: build ARM image → push to ECR → `docker compose pull && up -d` on the instance via SSM

Running cost: **~$60/month** on-demand, ~$36/month with a 1-year Savings Plan.
No Fargate, no ALB, no NAT gateway — exactly one instance.

## Prerequisites

1. **An AWS account.** Free tier is fine; you'll pay for the instance only.
2. **AWS CLI installed locally** and logged in: `brew install awscli && aws configure` (or the equivalent on Linux). You need this exactly once — after this doc, everything runs from GitHub Actions.
3. **A GitHub fork** of this repo.

## One-command onboarding

```bash
litellmctl deploy aws
```

`litellmctl` walks you through the whole setup interactively:

1. Verifies the `aws` + `gh` CLIs are installed and authenticated (prompts you to log in if not).
2. Auto-discovers your GitHub org/repo from the git remote and your email from `git config`.
3. Prompts for region, stack name, admin emails, allowed branches — each with a sensible default you can accept with `Enter`.
4. Detects any pre-existing GitHub OIDC provider in the account and reuses it (AWS only allows one per issuer URL).
5. Deploys the OIDC CloudFormation stack, grabs the role ARN.
6. Generates a `LITELLM_MASTER_KEY` if one isn't already set on the repo.
7. Pushes all five secrets to the repo via `gh secret set`.
8. Offers to dispatch the `deploy` workflow and tail it with `gh run watch`.

Safe to re-run — every step is idempotent.

### What's under the hood

If you prefer to do it by hand (or need to script around it), the five secrets are:

| Name                   | Source                                                      |
|------------------------|-------------------------------------------------------------|
| `AWS_DEPLOY_ROLE_ARN`  | Output of `aws/bootstrap-github-oidc.yml`                   |
| `AWS_REGION`           | Any region — `us-east-1` is the default                     |
| `APP_NAME`             | Stack name; default `litellm-gateway`                       |
| `LITELLM_MASTER_KEY`   | `sk-$(openssl rand -hex 24)`                                |
| `GATEWAY_ADMIN_EMAILS` | Comma-separated list of admin-role emails                   |

**Triggering a deploy.** The workflow only runs on:

- **Published GitHub Releases** cut from `main` — the production path. Releases from any other branch are ignored by the job-level `if`.
- **Manual `workflow_dispatch`** — from the Actions tab or `gh workflow run deploy.yml -r <branch>`. Works on **any branch** that has `.github/workflows/deploy.yml` committed. Use for ad-hoc deploys of a feature branch, or to ship a hotfix from `main` without tagging.

Branch pushes are intentionally NOT a trigger — iterate as much as you want without any AWS churn.

To ship: `git tag v0.1.0 && git push origin v0.1.0 && gh release create v0.1.0 --generate-notes`. The workflow fires on publish, builds `:v0.1.0` / `:<sha>` / `:latest` tags, and rolls the EC2 instance over via SSM.

Each run:

1. Deploys the main CloudFormation stack (ECR repo, EC2 instance, EIP, security group, IAM role — all idempotent; auto-recovers from `ROLLBACK_COMPLETE`)
2. Builds the ARM64 Docker image and pushes it to your ECR
3. SSH-free: uses AWS Systems Manager to run `docker compose pull && up -d` on the instance
4. Curls `/api/health` to confirm the gateway is up

First run takes ~8 min (EC2 launch + initial pull). Every subsequent deploy takes ~2 min.

When the workflow finishes, its summary prints the public IP. Open `http://<public-ip>:14041` and log in with the email you set in `GATEWAY_ADMIN_EMAILS`.

## Step 4 — Add a domain + HTTPS (optional, 2 min)

Inside the gateway UI, go to **Admin → Console** (real shell in the container) and edit the Caddyfile:

```bash
cat > /data/Caddyfile <<'CADDY'
your.domain.com {
  reverse_proxy localhost:14041
}
CADDY

caddy reload --config /data/Caddyfile --adapter caddyfile
```

Point an A record at the public IP — Caddy obtains a Let's Encrypt certificate automatically. Now your gateway is on `https://your.domain.com`.

## What lives where

Inside the container (read-only baked in the image):

```
/app/                    Repo code, venv at /opt/venv, bun at /root/.bun
/etc/s6-overlay/         Process supervisor config (inlined from Dockerfile)
```

On the EBS volume (`/opt/litellm/data` on the host, mounted as `/data` inside the container):

```
/data/.env               API keys, LITELLM_MASTER_KEY, GATEWAY_SESSION_SECRET
/data/config.yaml        Proxy routing (created by the wizard)
/data/auth.*.json        OAuth tokens per provider
/data/gateway/gateway.db SQLite: users, keys, usage, sessions, vectors
/data/plugins/           User-installed gateway plugins
/data/Caddyfile          Reverse proxy config
/data/logs/              proxy.log, gateway.log, ...
```

Sidecar containers (`ollama`, `searxng`, `whisper`) keep their own named Docker volumes. Ollama models persist across deploys — they only re-download when you blow away the volume.

### Using the container as a personal remote server

The admin has root inside the main container and full ownership of `/root`
— treat it as your remote box. The entrypoint seeds from image defaults on
first boot, then symlinks these paths to `/data/home/` so they survive
every redeploy:

| Path                   | What it's for                                              |
|------------------------|-------------------------------------------------------------|
| `~/.local`             | Claude Code binary + auto-updater state, `pip install --user`, custom scripts on `$PATH` |
| `~/.bun`               | `bun install -g` globals                                   |
| `~/.claude`            | Claude Code settings + conversation history               |
| `~/.npm`, `~/.cache`, `~/.config` | Generic XDG dirs                                |
| `~/.ssh`               | SSH keys if you want the container to act as an SSH client |
| `~/.bashrc`, `~/.bash_profile` | Your shell config — yours after first boot          |
| `~/scratch`            | Symlink to `/data/home` — a general-purpose scratch space |
| `~/.litellm`           | Convenience symlink to `/app` (the project). Its mutable subpaths — `.env`, `config.yaml`, `auth.*.json`, `gateway/gateway.db`, `plugins/`, `logs/` — are already individually symlinked to `/data/*`, so edits persist. |

**One caveat**: apt-installed packages land under `/etc`, `/usr`, `/var` —
those aren't persisted. On next container replace, they disappear. Two ways
to handle this:

1. **Drop a `/data/bootstrap.sh`** (executable). The entrypoint runs it on
   every boot, after `/data` is ready but before any longrun service
   starts. Put your `apt install -y foo bar`, env fixes, or systemd-ish
   overrides there. This is the supported escape hatch.
2. **Bake it into the image** — the Dockerfile is yours to edit; add `RUN apt-get install ...` and push a new build.

## Day-2 operations (from the web console)

The admin console is a full `bash -l` inside the container. `litellmctl` and
`claude` (Claude Code, pre-wired to the local proxy) are both on `$PATH`.

| Task                      | Command                                                    |
|---------------------------|-------------------------------------------------------------|
| Create `config.yaml`      | `litellmctl wizard`                                         |
| Log into a provider       | `litellmctl auth chatgpt` (or gemini, qwen, kimi)          |
| Restart the proxy         | `litellmctl restart proxy`                                  |
| Ask Claude Code for help  | `claude` (aliased to `claude --dangerously-skip-permissions`) |
| Enable ProtonMail OTP     | `litellmctl auth protonmail && litellmctl start protonmail` (auto-auths when Proton secrets are set) |
| Read an OTP from logs     | `docker compose -f /opt/litellm/compose.yml logs main --tail=100 \| grep -i 'OTP CODE'` |
| Pull a new embedding model| `docker exec litellm-ollama ollama pull nomic-embed-text`   |
| Tail logs                 | `litellmctl logs gateway`                                   |
| Stop everything           | `docker compose -f /opt/litellm/compose.yml down`          |
| Start everything          | `docker compose -f /opt/litellm/compose.yml up -d`         |

### Claude Code

The container ships Claude Code CLI configured to route through the local
LiteLLM proxy — no separate Anthropic API key required, no network path off
the instance for model calls.

Installed via the official native installer (`claude.ai/install.sh`) — a
per-platform binary with no Node/runtime dependency. The image bakes the
channel chosen at build time (`CLAUDE_CODE_CHANNEL` build arg: `latest`,
`stable`, or a pinned version like `2.1.89`), and the in-process
auto-updater stays on at runtime because `/root/.local` is persisted to
`/data/home/.local` — updates land on the data volume and survive
container rebuilds.

What's wired up:

- `ANTHROPIC_BASE_URL=http://localhost:4040` (the in-container proxy)
- `ANTHROPIC_AUTH_TOKEN=$LITELLM_MASTER_KEY` (inherited from compose env)
- Tier aliases match the existing `litellmctl` convention: opus→`ultra`,
  sonnet→`plus`, haiku→`lite`. Override via `ANTHROPIC_DEFAULT_*_MODEL` env
  vars in `/data/.env`.
- `alias claude='claude --dangerously-skip-permissions'` — inside the
  container the admin role already bypasses the host security boundary, and
  interactive approval prompts break automation. Disable by removing the
  alias from `/root/.bashrc` if you prefer the prompts.
- Claude's state (`/root/.claude`) is symlinked to `/data/claude` so
  conversation history survives container rebuilds.

## Troubleshooting

**Workflow fails at "Deploy CloudFormation stack".** Usually the OIDC role is missing a permission — check the CloudFormation console → stack events. The role created by `bootstrap-github-oidc.yml` has `cloudformation:*` + `ec2:*` + `iam:*` + `ecr:*` + `ssm:*` in V1; tighten after your stack stabilises.

**Instance starts but `/api/health` times out.** SSH in via SSM Session Manager:

```bash
aws ssm start-session --target $(aws cloudformation describe-stacks \
  --stack-name litellm-gateway \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text)
```

Then `sudo docker compose -f /opt/litellm/compose.yml logs -f main` to see the main container logs.

**"No space left on device".** Ollama models are big (~5–10 GB each). 120 GB is usually plenty, but blow away unused models: `docker exec litellm-ollama ollama rm <model>`.

**Need to change the instance size.** Rerun the workflow with `workflow_dispatch` and the `instance_type` input, or edit `.github/workflows/deploy.yml`. CloudFormation handles the resize (brief downtime).

## Local development

The same image runs locally. From the repo root:

```bash
docker build --platform linux/arm64 -t litellm-gw:dev .

mkdir -p .data
docker compose -f docker/compose.yml up
```

Sidecars pull automatically. Open `http://localhost:14041`.

The VPC install path (`install.sh` + `litellmctl` with launchd/systemd) is
completely independent of this. Don't run both on the same host.
