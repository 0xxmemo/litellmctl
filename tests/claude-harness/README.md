# claude-harness

Drive the host's `claude -p` against the local litellm proxy so we can
catch proxy/adapter bugs **without** pushing speculative fixes to the
prod EC2 instance and waiting on Claude Code retries to confirm.

## Why it exists

`~/.claude/settings.json` carries `env.ANTHROPIC_BASE_URL` (pointing at
prod). Claude Code's bootstrap (`utils/managedEnv.ts` →
`applySafeConfigEnvironmentVariables`) Object-assigns that user-settings
env onto `process.env` **after** shell exports. So this naive harness
silently lies:

```bash
ANTHROPIC_BASE_URL=http://localhost:4040 claude -p hello   # ← still hits prod!
```

The harness pins the test by combining:

| flag                       | effect                                                       |
| -------------------------- | ------------------------------------------------------------ |
| `--bare`                   | skip hooks, MCP, plugins, OAuth, keychain, CLAUDE.md         |
| `--setting-sources ""`     | drop user/project/local settings; only flag/policy remain    |
| `--settings '<json>'`      | inject env as flagSettings — applied last, overrides all     |
| `env -i`                   | belt-and-braces against direct `process.env.X` reads pre-init |

Reference: `/Users/anon/.litellm/ref/claude-code/src/utils/managedEnv.ts`

## Usage

```bash
# default: localhost:4040, kimi-code/kimi-for-coding, prompt "hello"
./tests/claude-harness/run.sh

# pick a model
./tests/claude-harness/run.sh codex/gpt-5.4-mini
./tests/claude-harness/run.sh alibaba/qwen3.6-plus

# different prompt
PROMPT="write a python hello world" ./tests/claude-harness/run.sh

# different proxy (e.g. point at a staging machine you've SSH-tunneled)
BASE_URL=http://localhost:18041 ./tests/claude-harness/run.sh

# longer timeout for big prompts
TIMEOUT_SEC=180 ./tests/claude-harness/run.sh
```

## What it asserts

| check                              | catches                                         |
| ---------------------------------- | ----------------------------------------------- |
| `claude` exits 0                   | upstream 5xx, transport errors, claude crashes  |
| no `Retrying / attempt N/M` lines  | malformed responses that trigger the retry loop |
| stdout ≥ 2 bytes                   | silent zero-content responses                   |
| no `StreamingChoices`/`Traceback`/`API Error: 500` | known adapter blowups                  |

Logs land in `$TMPDIR/claude-harness/<runid>.{stdout,stderr,debug}.log`
for inspection on failure.

## Limitations

- Reproduces only what the **local** proxy does. A bug that manifests
  only on prod (different Python version, different platform, etc.)
  won't show up here. For prod-only bugs, add a Linux/Docker variant
  alongside `tests/linux-harness/`.
- Uses `LITELLM_MASTER_KEY` from `.env`. If you point `BASE_URL` at a
  remote that doesn't accept this key, you'll see 401s — by design.
