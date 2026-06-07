# Anthropic Claude Adapter

This adapter enables using Anthropic's Claude models as agent backends in Criteria workflows (protocol v2).

## Features

- Multi-turn conversations with Claude models
- Tool calling with `submit_outcome` for workflow integration
- Support for different models (claude-sonnet-4-6, claude-opus-4-7, claude-haiku-4-5, etc.)
- Configurable max turns and max tokens per step
- Structured events for observability
- Snapshot / restore for resumable sessions
- Secret-channel-only API key handling (no env-var leakage)

## Setup

1. **Install dependencies:**
   ```bash
   bun install
   ```

2. **Configure secrets via the Criteria host secret provider** (e.g. `secrets.provider = "env"`):
   ```bash
   export ANTHROPIC_API_KEY="sk-ant-..."
   export ANTHROPIC_BASE_URL="https://api.anthropic.com"   # optional
   ```

3. **Build the adapter:**
   ```bash
   bun run build
   ```

4. **Install to Criteria plugins directory:**
   ```bash
   mkdir -p ~/.criteria/plugins
   cp out/adapter ~/.criteria/plugins/criteria-adapter-claude
   chmod +x ~/.criteria/plugins/criteria-adapter-claude
   ```

## Usage

Create a workflow file:

```hcl
workflow "code-review" {
  version       = "0.1"
  initial_state = "analyze"
  target_state  = "done"
}

adapter "claude" "default" {
  config {
    model         = "claude-sonnet-4-6"
    max_turns     = 10
    max_tokens    = 4096
    system_prompt = "You are a code reviewer."
  }
}

step "analyze" {
  target = adapter.claude.default

  input {
    prompt = "Review this code for bugs: $(file src/main.ts)"
  }

  outcome "clean"        { next = state.deploy }
  outcome "issues_found" { next = state.fix }
  outcome "failure"      { next = state.failed }
}
```

Run the workflow:
```bash
criteria apply workflow.hcl
```

## Configuration

### Adapter config (set once per adapter block)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `model` | string | No | `claude-sonnet-4-6` | Model to use |
| `max_turns` | number | No | `10` | Default max turns per step |
| `max_tokens` | number | No | `4096` | Max tokens per response |
| `system_prompt` | string | No | - | System prompt for the session |

### Step-level input (set per step)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | **Yes** | The prompt to send to Claude |
| `max_turns` | number | No | Per-step override for max turns |
| `max_tokens` | number | No | Per-step override for max tokens |
| `model` | string | No | Per-step override for model |

### Secrets

| Name | Required | Description |
|------|----------|-------------|
| `ANTHROPIC_API_KEY` | **Yes** | Anthropic API key |
| `ANTHROPIC_BASE_URL` | No | Override the Anthropic API base URL |

API keys arrive over the Criteria **secret channel** only — never read from the
process environment.

### Config overrides

`model`, `max_turns`, and `max_tokens` exist in **both** the adapter `config {}`
(session default) and step `input {}` (per-step override). A step input wins for
that step only. `system_prompt` is session-scoped (set once at session open) and
is not overridable per step.

### Outputs

| Output | Type | Description |
|--------|------|-------------|
| `reason` | string | Reason for the chosen outcome (from `submit_outcome`). |

The step **outcome** is set by the model calling `submit_outcome(outcome, reason)`
and is validated against the step's declared outcomes; assistant turns and tool
calls are also emitted as structured events for observability.

## How It Works

The adapter implements a multi-turn conversation loop:

1. **Session Open**: Creates an Anthropic client using secrets from the host, stores conversation history in `helpers.session`
2. **Execute**: Sends the prompt to Claude with a `submit_outcome` tool
3. **Tool Calling**: The model can call `submit_outcome(outcome, reason)` to finalize
4. **Outcome Validation**: The adapter validates the outcome via `helpers.outcomes.validate()` against allowed outcomes
5. **Result**: Returns the outcome to Criteria for workflow transition via `helpers.outcomes.finalize()`

### Shelling out safely

If the adapter ever shells out to a CLI, use `helpers.secrets.spawnEnv(...)` to build a redacted environment map:

```typescript
const env = await helpers.secrets.spawnEnv(["ANTHROPIC_API_KEY"]);
spawn("some-cli", [...], { env });
```

## Security & dependencies

Supply-chain controls and the dependency-freshness policy are documented in
[SECURITY.md](SECURITY.md) and [docs/dependency-policy.md](docs/dependency-policy.md).
Reproduce the CI security checks locally:

```bash
bun run vuln-scan      # osv-scanner — blocking known-vulnerability gate (reads bun.lock)
bun run deps:outdated  # bun outdated — freshness report
```

## Publish

Tagging `vX.Y.Z` runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml),
which cross-compiles `linux/amd64`, `linux/arm64`, and `darwin/arm64` with
`bun build --compile --target=…` and publishes them as a single multi-platform,
signed OCI artifact to `ghcr.io/brokenbots/criteria-adapter-claude:X.Y.Z` via the
reusable [`brokenbots/publish-adapter`](https://github.com/brokenbots/publish-adapter)
action. Pin and lock it in your workflow with `criteria adapter lock`.

## Development

To modify the adapter:

1. Edit `index.ts`
2. Rebuild: `bun run build`
3. Run tests: `bun test`
4. Run the security checks: `bun run vuln-scan`
5. Test with `criteria apply`
