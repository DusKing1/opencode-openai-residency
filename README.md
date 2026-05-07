# opencode-openai-residency

[OpenCode](https://github.com/anomalyco/opencode) plugin for OpenAI Codex API tweaks:

1. **Data residency** — adds `x-openai-internal-codex-residency` for OpenAI Enterprise workspaces with regional restrictions.
2. **gpt-5.5 unlock** *(opt-in)* — overrides the `User-Agent` / `originator` headers on outgoing codex requests so they pass OpenAI's `codex_cli_rs` client gate.

This mirrors how the official [Codex CLI](https://github.com/openai/codex/blob/main/codex-rs/core/src/default_client.rs) talks to the Codex backend.

> **Note**: If OpenCode merges built-in residency support ([PR #15844](https://github.com/anomalyco/opencode/pull/15844)), feature 1 becomes unnecessary.

## Install

Add to your `opencode.json`:

```jsonc
{
  "plugin": ["opencode-openai-residency"],
  "provider": {
    "openai": {
      "options": {
        "enforce_residency": "us",        // feature 1 — residency header
        "ua_override": true               // feature 2 — gpt-5.5 unlock (opt-in)
      }
    }
  }
}
```

Restart OpenCode. The plugin is auto-loaded.

## Feature 1 — Residency header

Without `x-openai-internal-codex-residency`, OpenAI Enterprise Codex API requests from non-US regions are rejected with `401 "Workspace is not authorized in this region"`. Set `enforce_residency` to the required region string (e.g. `"us"`) and the plugin attaches the header on every OpenAI provider call.

If `enforce_residency` is unset, the hook does nothing.

## Feature 2 — gpt-5.5 unlock (opt-in)

As of 2026-05-07, OpenAI gates `gpt-5.5` (and other reasoning models on the codex pathway) by an **AND-gate** on two HTTP headers:

| Header        | Required value                          |
| ------------- | --------------------------------------- |
| `User-Agent`  | must start with `codex_cli_rs`          |
| `originator`  | must be exactly `codex_cli_rs`          |

If either is wrong, the request enters reasoning and dies mid-stream with a silent `server_error` — looks like backend instability, isn't. Only the official Codex Rust CLI passes the check by default.

opencode's default UA (`opencode/1.14.39 ...`) and originator (`opencode`) both fail it. **Why a `chat.headers` hook can't fix this**: opencode 1.14.39's Vercel AI SDK constructs its own request and ignores hook overrides on default headers like `User-Agent`. The only effective injection point is patching `globalThis.fetch` at module load, which is what this plugin does when `ua_override: true`.

The patch is scoped to `chatgpt.com/backend-api/codex` and `api.openai.com` only; all other fetches pass through untouched.

### Why opt-in (default off)

The override changes how opencode identifies itself to OpenAI's codex backend. Practical risk is low (just two headers, no payload tampering, no auth/payment bypass), but enabling it is the user's explicit choice. The config key is `ua_override` even though it overrides both `User-Agent` and `originator` — those two headers together form a single client-identity check from OpenAI's side.

### Risks

- **OpenAI may add deeper fingerprinting** (TLS, timing, payload heuristics). If/when that happens, this stops working.
- **opencode internals** — if a future opencode version bypasses `globalThis.fetch` (e.g. uses `Bun.fetch` directly), the patch silently stops applying.

### Debug / verification

Set `OPENCODE_RESIDENCY_DEBUG=1` in the environment to log every codex/openai request the plugin intercepts. By default the log goes to stderr; set `OPENCODE_RESIDENCY_DEBUG_FILE=/path/to/log` to redirect to a file (useful inside the opencode TUI which swallows stderr).

Example output when `ua_override` is on:

```
[2026-05-07T13:03:34.362Z] fetch patch installed
[2026-05-07T13:03:36.972Z] intercepted https://chatgpt.com/backend-api/codex/responses | UA opencode/1.14.40 (...) ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13 -> codex_cli_rs/0.20.0 | originator opencode -> codex_cli_rs
```

If you set `ua_override: false` (or omit it) the log file stays empty — the patch isn't installed, fetches pass through untouched.

## License

MIT
