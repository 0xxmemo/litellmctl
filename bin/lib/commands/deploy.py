"""`litellmctl deploy` — one-shot onboarding for container targets.

Currently one target:
    aws — EC2 Graviton + EBS + EIP + ECR, wired to the GitHub `deploy.yml`
          workflow. See aws/cloudformation.yml and aws/bootstrap-github-oidc.yml.

What it does, interactively:
    1. Verifies `aws`, `gh`, `git` are installed and authenticated.
    2. Auto-discovers defaults from the git remote + `git config user.email`.
    3. Prompts for region, stack name, admin emails.
    4. Detects any pre-existing GitHub OIDC provider and reuses it.
    5. Deploys aws/bootstrap-github-oidc.yml to create the deploy role.
    6. Generates a LITELLM_MASTER_KEY (or reuses the one already on the repo).
    7. Pushes all 5 secrets to the repo via `gh secret set`.
    8. Offers to dispatch `deploy.yml` once (workflow_dispatch) to bootstrap
       the AWS resources. Subsequent deploys happen automatically when you
       publish a GitHub Release cut from `main`.

Every step is idempotent. Safe to re-run.
"""

from __future__ import annotations

import json
import os
import secrets as _secrets
import shutil
import subprocess
import sys
import time
import webbrowser

from ..common.formatting import console, info, warn, error
from ..common.paths import PROJECT_DIR
from ..common.prompts import ask, confirm, select


# ── Shell helpers ────────────────────────────────────────────────────────────

def _run(
    cmd: list[str],
    *,
    check: bool = True,
    capture: bool = False,
    input_: str | None = None,
) -> subprocess.CompletedProcess:
    """Run a shell command. Raises on non-zero exit unless check=False."""
    return subprocess.run(
        cmd,
        check=check,
        text=True,
        capture_output=capture,
        input=input_,
    )


def _run_out(cmd: list[str]) -> str:
    """Run and return stdout.strip(), raising on non-zero exit."""
    return _run(cmd, capture=True).stdout.strip()


def _has(bin_name: str) -> bool:
    return shutil.which(bin_name) is not None


def _aws_is_authed() -> bool:
    return _run(
        ["aws", "sts", "get-caller-identity"],
        check=False, capture=True,
    ).returncode == 0


def _open_browser(url: str) -> None:
    """Best-effort open URL in the default browser. Never raises."""
    try:
        webbrowser.open(url)
    except Exception:
        pass


_IAM_ACCESS_KEY_URL = "https://console.aws.amazon.com/iam/home?#/security_credentials"
_AWS_SSO_DOCS = "https://docs.aws.amazon.com/singlesignon/latest/userguide/get-set-up-for-idc.html"


def _aws_login_access_key() -> bool:
    """Walk the user through creating an IAM access key in the console."""
    info("Create an IAM access key")
    console.print()
    console.print("  [bold]1.[/] Opening [cyan]console.aws.amazon.com/iam[/] → Security credentials in your browser.")
    console.print(f"     [dim]Manual link: {_IAM_ACCESS_KEY_URL}[/]")
    console.print("  [bold]2.[/] Click [bold]Create access key[/] → choose [bold]Command Line Interface (CLI)[/] → [bold]Create[/]")
    console.print("  [bold]3.[/] Copy the [bold]Access key ID[/] and [bold]Secret access key[/] — you only see the secret once.")
    console.print("  [bold]4.[/] Come back and paste them into the [italic]aws configure[/] prompts below.")
    console.print()
    console.print("  [dim]The region prompt accepts things like `us-east-1`, `eu-central-1`, `us-west-2`.[/]")
    console.print("  [dim]Leave \"Default output format\" blank — press Enter.[/]")
    console.print()

    _open_browser(_IAM_ACCESS_KEY_URL)

    if not confirm("Ready to run `aws configure`?", default=True):
        return False

    console.print("\n  [dim]running: aws configure  (Ctrl+C to abort)[/]\n")
    ret = subprocess.run(["aws", "configure"], check=False).returncode
    console.print()
    if ret != 0:
        warn(f"aws configure exited with code {ret}")
        return False
    return _aws_is_authed()


def _aws_login_sso() -> bool:
    """Guide the user through IAM Identity Center SSO."""
    info("AWS IAM Identity Center (SSO) login")
    console.print()
    console.print("  You need two things from your AWS org:")
    console.print("    • [bold]SSO start URL[/] — looks like [cyan]https://d-xxxxxxxxxx.awsapps.com/start[/]")
    console.print("    • [bold]SSO region[/] — the region your Identity Center is in, e.g. [cyan]us-east-1[/]")
    console.print()
    console.print("  Where to find them:")
    console.print("    AWS console → [bold]IAM Identity Center[/] → top of the dashboard shows the start URL + region.")
    console.print(f"    [dim]Docs: {_AWS_SSO_DOCS}[/]")
    console.print()
    console.print("  [dim]No Identity Center set up? Cancel this and pick the Access Key path instead.[/]")
    console.print()

    if not confirm("Ready to run `aws configure sso`?", default=True):
        return False

    console.print("\n  [dim]running: aws configure sso  (a browser tab opens mid-flow; approve there)[/]\n")
    ret = subprocess.run(["aws", "configure", "sso"], check=False).returncode
    console.print()
    if ret != 0:
        warn(f"aws configure sso exited with code {ret}")
        return False
    return _aws_is_authed()


def _aws_login_interactive() -> bool:
    """Offer a guided auth flow. Returns True if authed after."""
    warn("aws CLI is not authenticated.")
    choice = select(
        "Which login method?",
        choices=[
            "Access Key — paste credentials from the AWS console (works for any account)",
            "SSO — browser login (requires IAM Identity Center already set up)",
            "Cancel — I'll do it in another shell",
        ],
    )
    if choice is None or "Cancel" in choice:
        return False
    if "SSO" in choice:
        return _aws_login_sso()
    return _aws_login_access_key()


def _gh_is_authed() -> bool:
    return _run(["gh", "auth", "status"], check=False, capture=True).returncode == 0


def _gh_login_interactive() -> bool:
    """Offer `gh auth login` inline with guidance. Returns True if authed after."""
    warn("gh CLI is not authenticated.")
    console.print()
    console.print("  `gh auth login` walks you through these prompts:")
    console.print("    • [bold]Where do you use GitHub?[/] → [cyan]GitHub.com[/]")
    console.print("    • [bold]Preferred protocol[/] → [cyan]HTTPS[/] (SSH works too)")
    console.print("    • [bold]Authenticate Git with GitHub credentials?[/] → [cyan]Yes[/]")
    console.print("    • [bold]How would you like to authenticate?[/] → [cyan]Login with a web browser[/] (recommended)")
    console.print()
    console.print("  [dim]It prints a one-time code, opens your browser to github.com/login/device, and completes once you paste the code.[/]")
    console.print()
    if not confirm("Run `gh auth login` now?", default=True):
        return False
    console.print("\n  [dim]running: gh auth login[/]\n")
    ret = subprocess.run(["gh", "auth", "login"], check=False).returncode
    console.print()
    if ret != 0:
        warn(f"gh auth login exited with code {ret}")
        return False
    return _gh_is_authed()


# ── AWS onboarding ───────────────────────────────────────────────────────────

def _aws_deploy() -> None:
    info("Checking prerequisites")

    if not _has("aws"):
        error("aws CLI not found. Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html")
        sys.exit(1)
    if not _has("gh"):
        error("gh CLI not found. Install: https://cli.github.com/")
        sys.exit(1)
    if not _has("git"):
        error("git not found")
        sys.exit(1)

    aws_version = _run_out(["aws", "--version"]).split()[0].split("/")[-1]
    gh_version = _run_out(["gh", "--version"]).split("\n")[0].split()[2]
    console.print(f"  [green]✓[/] aws {aws_version}")
    console.print(f"  [green]✓[/] gh {gh_version}")

    # AWS auth — offer to run `aws configure` inline if not logged in
    if not _aws_is_authed():
        if not _aws_login_interactive():
            error("AWS is still not authenticated — aborted.")
            sys.exit(1)
    caller = json.loads(_run_out(["aws", "sts", "get-caller-identity"]))
    console.print(f"  [green]✓[/] AWS: [cyan]{caller['Arn']}[/]")
    account = caller["Account"]

    # GitHub auth — offer `gh auth login` inline if not logged in
    if not _gh_is_authed():
        if not _gh_login_interactive():
            error("GitHub CLI is still not authenticated — aborted.")
            sys.exit(1)
    gh_user = _run_out(["gh", "api", "user", "-q", ".login"])
    console.print(f"  [green]✓[/] GitHub: [cyan]{gh_user}[/]\n")

    # ── Defaults from git ────────────────────────────────────────────────
    try:
        remote_url = _run_out(["git", "-C", str(PROJECT_DIR), "config", "--get", "remote.origin.url"])
    except subprocess.CalledProcessError:
        remote_url = ""

    gh_org_default = gh_repo_default = ""
    if remote_url.startswith("git@github.com:"):
        slug = remote_url[len("git@github.com:"):].removesuffix(".git")
    elif remote_url.startswith("https://github.com/"):
        slug = remote_url[len("https://github.com/"):].removesuffix(".git")
    else:
        slug = ""
    if "/" in slug:
        gh_org_default, gh_repo_default = slug.split("/", 1)

    try:
        current_branch = _run_out(["git", "-C", str(PROJECT_DIR), "rev-parse", "--abbrev-ref", "HEAD"])
    except subprocess.CalledProcessError:
        current_branch = "main"
    try:
        git_email = _run_out(["git", "-C", str(PROJECT_DIR), "config", "--get", "user.email"])
    except subprocess.CalledProcessError:
        git_email = ""

    # ── Prompts ──────────────────────────────────────────────────────────
    info("Configuration")

    region = ask("AWS region", default=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
    app_name = ask("Stack / app name", default="litellm-gateway")
    gh_org = ask("GitHub org", default=gh_org_default)
    gh_repo = ask("GitHub repo", default=gh_repo_default)

    admin_emails = ask("Admin email(s), comma-separated", default=git_email or "you@example.com")

    # ── Optional: ProtonMail SMTP for OTP delivery ───────────────────────
    # If skipped, the gateway logs OTP codes to stdout (readable via
    # `docker compose logs main` or the admin web console). That's enough
    # for the first admin login.
    proton_email = proton_user = proton_pass = proton_totp = ""
    if confirm("Wire ProtonMail SMTP for OTP emails? (say no to read OTPs from container logs instead)", default=False):
        # Try to seed from /data/.env on the local machine if present.
        env_file = PROJECT_DIR / ".env"
        seeded: dict[str, str] = {}
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if "=" in line and not line.strip().startswith("#"):
                    k, _, v = line.partition("=")
                    seeded[k.strip()] = v.strip()
        proton_email = ask("GATEWAY_PROTON_EMAIL", default=seeded.get("GATEWAY_PROTON_EMAIL", ""))
        proton_user  = ask("GATEWAY_PROTON_USERNAME", default=seeded.get("GATEWAY_PROTON_USERNAME", proton_email.split("@")[0] if "@" in proton_email else ""))
        proton_pass  = ask("GATEWAY_PROTON_PASSWORD (account password)", default=seeded.get("GATEWAY_PROTON_PASSWORD", ""))
        proton_totp  = ask("GATEWAY_PROTON_2FA_SECRET (TOTP seed, blank if no 2FA)", default=seeded.get("GATEWAY_PROTON_2FA_SECRET", ""))

    repo = f"{gh_org}/{gh_repo}"
    oidc_stack = f"{app_name}-oidc"

    # Decide whether to rotate the master key
    reuse_key = False
    try:
        out = _run_out(["gh", "secret", "list", "-R", repo, "--json", "name"])
        reuse_key = any(s.get("name") == "LITELLM_MASTER_KEY" for s in json.loads(out))
    except Exception:
        reuse_key = False

    if reuse_key:
        warn("LITELLM_MASTER_KEY already set on the repo — leaving it alone.")
        master_key = ""
    else:
        master_key = "sk-" + _secrets.token_hex(24)
        console.print("  [green]✓[/] generated a new LITELLM_MASTER_KEY (48 hex chars)")

    # ── Summary + confirm ────────────────────────────────────────────────
    info("About to do the following — confirm before anything touches AWS:")
    console.print(f"  [dim]region           [/]{region}")
    console.print(f"  [dim]account          [/]{account}")
    console.print(f"  [dim]app / stack name [/]{app_name}")
    console.print(f"  [dim]github repo      [/]{repo}")
    console.print(f"  [dim]admin emails     [/]{admin_emails}")
    console.print(f"  [dim]OIDC stack       [/]{oidc_stack}")
    console.print(
        f"  [dim]reuse master key [/]{'yes' if reuse_key else 'no (new key will be set)'}"
    )
    if not confirm("Continue?", default=True):
        error("aborted")
        sys.exit(1)

    # ── Detect existing OIDC provider ────────────────────────────────────
    info("Detecting existing GitHub OIDC provider")
    existing_arn = ""
    try:
        res = _run_out([
            "aws", "iam", "list-open-id-connect-providers",
            "--query",
            "OpenIDConnectProviderList[?contains(Arn, 'token.actions.githubusercontent.com')].Arn | [0]",
            "--output", "text",
        ])
        if res and res not in ("None", "null"):
            existing_arn = res
    except subprocess.CalledProcessError:
        pass

    if existing_arn:
        console.print(f"  [green]✓[/] reusing existing provider: [cyan]{existing_arn}[/]")
    else:
        console.print("  [green]✓[/] no provider present — CFN will create one")

    # ── Deploy OIDC bootstrap stack ──────────────────────────────────────
    info(f"Deploying {oidc_stack} (CloudFormation)")

    template = str(PROJECT_DIR / "aws" / "bootstrap-github-oidc.yml")
    if not os.path.exists(template):
        error(f"template missing: {template}")
        sys.exit(1)

    _run([
        "aws", "cloudformation", "deploy",
        "--stack-name", oidc_stack,
        "--template-file", template,
        "--capabilities", "CAPABILITY_NAMED_IAM",
        "--no-fail-on-empty-changeset",
        "--region", region,
        "--parameter-overrides",
        f"GithubOrg={gh_org}",
        f"GithubRepo={gh_repo}",
        f"AppName={app_name}",
        f"ExistingOidcProviderArn={existing_arn}",
    ])

    role_arn = _run_out([
        "aws", "cloudformation", "describe-stacks",
        "--stack-name", oidc_stack, "--region", region,
        "--query", "Stacks[0].Outputs[?OutputKey==`RoleArn`].OutputValue",
        "--output", "text",
    ]).strip()

    # Validate — the aws-actions/configure-aws-credentials action needs a full
    # IAM role ARN, not a name. A blank or malformed value here silently turns
    # into "Source Account ID is needed if the Role Name is provided ..." on
    # the workflow side.
    import re
    if not re.fullmatch(r"arn:aws:iam::\d{12}:role/[\w+=,.@-]+", role_arn):
        error(f"CFN returned an unexpected role ARN: {role_arn!r}")
        error("Expected format: arn:aws:iam::<account>:role/<name>")
        sys.exit(1)
    console.print(f"  [green]✓[/] deploy role: [cyan]{role_arn}[/]")

    # ── GitHub secrets ───────────────────────────────────────────────────
    info(f"Writing GitHub Actions secrets to {repo}")

    def set_secret(name: str, value: str) -> None:
        # Always strip — `gh secret set --body -` used to preserve trailing
        # newlines from stdin, which then broke tools that do strict ARN
        # validation (e.g. aws-actions/configure-aws-credentials). Pass via
        # --body directly instead of stdin to avoid the issue entirely.
        clean = value.strip()
        if not clean:
            error(f"refusing to set empty secret {name}")
            sys.exit(1)
        _run(["gh", "secret", "set", name, "-R", repo, "--body", clean])
        console.print(f"  [green]✓[/] set {name}")

    set_secret("AWS_DEPLOY_ROLE_ARN", role_arn)
    set_secret("AWS_REGION", region)
    set_secret("APP_NAME", app_name)
    set_secret("GATEWAY_ADMIN_EMAILS", admin_emails)
    if not reuse_key:
        set_secret("LITELLM_MASTER_KEY", master_key)
        console.print("  [dim]   master key saved only to GitHub secrets — store it yourself if you want a copy.[/]")

    # Only overwrite Proton secrets if the user provided values. Empty string
    # would clobber an existing secret — skip instead so re-runs don't wipe.
    if proton_email:
        set_secret("GATEWAY_PROTON_EMAIL", proton_email)
    if proton_user:
        set_secret("GATEWAY_PROTON_USERNAME", proton_user)
    if proton_pass:
        set_secret("GATEWAY_PROTON_PASSWORD", proton_pass)
    if proton_totp:
        set_secret("GATEWAY_PROTON_2FA_SECRET", proton_totp)

    # ── Trigger workflow ─────────────────────────────────────────────────
    # `workflow_dispatch` can target any branch that has the workflow file
    # committed. Releases, by contrast, only auto-deploy when cut from `main`.
    info("Deploy workflow")
    console.print(
        "  [dim]Dispatch works on any branch — only auto-deploys from published releases[/]"
    )
    console.print(
        "  [dim]are restricted to `main`. GitHub rejects dispatches against refs that[/]"
    )
    console.print(
        "  [dim]don't have .github/workflows/deploy.yml yet (HTTP 422).[/]"
    )
    run_branch = ask("Branch to deploy", default=current_branch or "main")

    if confirm(f"Dispatch deploy.yml on {run_branch} now?", default=True):
        dispatch = _run(
            ["gh", "workflow", "run", "deploy.yml", "-R", repo, "-r", run_branch],
            check=False, capture=True,
        )
        if dispatch.returncode != 0:
            msg = (dispatch.stderr or dispatch.stdout or "").strip()
            error(f"gh workflow run failed: {msg}")
            if "workflow_dispatch" in msg or "HTTP 422" in msg:
                console.print(
                    f"  [dim]The `{run_branch}` ref on GitHub doesn't have .github/workflows/deploy.yml yet.[/]"
                )
                console.print("  [dim]Push this branch first, then retry:[/]")
                console.print(f"  [dim]   git push origin {current_branch}[/]")
                console.print(f"  [dim]   gh workflow run deploy.yml -R {repo} -r {current_branch}[/]")
            sys.exit(1)
        console.print("  [green]✓[/] workflow dispatched")

        time.sleep(3)
        try:
            run_id = _run_out([
                "gh", "run", "list", "-R", repo,
                "-w", "deploy.yml", "-b", run_branch, "-e", "workflow_dispatch",
                "--limit", "1", "--json", "databaseId",
                "-q", ".[0].databaseId",
            ])
        except subprocess.CalledProcessError:
            run_id = ""

        if run_id and run_id != "null":
            console.print(f"  [dim]run id: {run_id}[/]")
            if confirm("Watch the run in this terminal?", default=True):
                _run(
                    ["gh", "run", "watch", "-R", repo, run_id, "--exit-status"],
                    check=False,
                )
                _run(["gh", "run", "view", "-R", repo, run_id], check=False)
            else:
                console.print(
                    f"  [dim]view later: gh run view -R {repo} {run_id} --log[/]"
                )
        else:
            warn("couldn't locate the run id — check: gh run list -R " + repo + " -w deploy.yml")
    else:
        console.print(
            f"  [dim]trigger later: gh workflow run deploy.yml -R {repo} -r {run_branch}[/]"
        )

    info("Done")
    console.print(f"  [dim]First deploy takes ~8 min (EC2 launch + initial image pulls).[/]")
    console.print(f"  [dim]Auto deploy:  cut a release from `main` — `gh release create vX.Y.Z --generate-notes`[/]")
    console.print(f"  [dim]Manual:       gh workflow run deploy.yml -R {repo} -r <branch>  (any branch with the workflow file)[/]")
    console.print(f"  [dim]Tear main:    aws cloudformation delete-stack --stack-name {app_name} --region {region}[/]")
    console.print(f"  [dim]Tear OIDC:    aws cloudformation delete-stack --stack-name {oidc_stack} --region {region}  (also destroys ECR + images)[/]")
    console.print(f"  [dim]              aws ecr delete-repository --repository-name {app_name} --region {region} --force  # needed if ECR isn't empty[/]")


# ── Dispatcher ───────────────────────────────────────────────────────────────

TARGETS = {
    "aws": _aws_deploy,
}


def cmd_deploy(target: str) -> None:
    fn = TARGETS.get(target.lower())
    if fn is None:
        error(f"Unknown deploy target: {target}")
        console.print(f"  Available: {', '.join(TARGETS)}")
        sys.exit(2)
    try:
        fn()
    except KeyboardInterrupt:
        warn("cancelled")
        sys.exit(130)
    except subprocess.CalledProcessError as e:
        error(f"command failed: {' '.join(e.cmd)} (exit {e.returncode})")
        if e.stderr:
            console.print(e.stderr, highlight=False)
        sys.exit(e.returncode)
