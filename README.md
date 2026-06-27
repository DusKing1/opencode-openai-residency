# opencode-openai-residency

[OpenCode](https://github.com/anomalyco/opencode) plugin for OpenAI Codex API tweaks:

1. **Data residency** — adds `x-openai-internal-codex-residency` for OpenAI Enterprise workspaces with regional restrictions.
2. **gpt-5.5 unlock** *(opt-in)* — overrides the `User-Agent` / `originator` headers on outgoing codex requests so they pass OpenAI's `codex_cli_rs` client gate.
3. **gpt-5.6-sol WebSocket transport** *(opt-in)* — serves WS-only Codex models (e.g. `gpt-5.6-sol`) over the Codex WebSocket transport, which plain HTTP cannot reach.

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
        "enforce_residency": "us",          // feature 1 — residency header
        "ua_override": true,                // feature 2 — gpt-5.5/terra/luna unlock
        "ws_transport": true,               // feature 3 — gpt-5.6-sol WS transport (opt-in)
        "ua_version": "999.999.999",        // optional — codex_cli_rs version, defaults high
        "ws_models": ["gpt-5.6-sol"]        // optional — models forced over WS, defaults to this
      },
      "models": {
        "gpt-5.6-sol": {
          "name": "GPT-5.6-Sol",
          "reasoning": true,
          // service_tier:"priority" is injected automatically by the plugin's WS
          // transport for every model in ws_models — no model config needed for it.
          "variants": {
            "low":    { "reasoningEffort": "low" },
            "medium": { "reasoningEffort": "medium" },
            "high":   { "reasoningEffort": "high" },
            "xhigh":  { "reasoningEffort": "xhigh" },
            "max":    { "reasoningEffort": "max" }
          },
          "limit": { "context": 372000, "output": 128000 }
        }
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
[2026-05-07T13:03:36.972Z] intercepted https://chatgpt.com/backend-api/codex/responses | UA opencode/1.14.40 (...) ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13 -> codex_cli_rs/999.999.999 (...) | originator opencode -> codex_cli_rs
```

If you set `ua_override: false` (or omit it) the log file stays empty — the patch isn't installed, fetches pass through untouched.

## Feature 3 — gpt-5.6-sol WebSocket transport (opt-in)

`gpt-5.6-sol` is **not** served over plain HTTP. A normal POST to `/responses` always returns a mid-stream `server_error` for sol, regardless of headers. It is served **only** over the Codex WebSocket transport, and the body must additionally carry `service_tier: "priority"` — the only accepted tier (there is no `gpt-5.x-fast` model name and no `service_tier: "fast"` value).

opencode has a built-in WebSocket path, but it is constructed from `OPENCODE_EXPERIMENTAL_WEBSOCKETS` **before** user plugins load, so a plugin cannot enable it. To avoid forcing an env var, this plugin performs the WS round-trip itself when `ws_transport: true`: it intercepts the streaming POST to the Codex `/responses` endpoint for any model in `ws_models`, replays it over `wss://`, injects `service_tier: "priority"` if absent, and translates the WebSocket frames back into the SSE stream opencode's Responses parser consumes.

| Option | Default | Meaning |
| -------------- | ----------------- | ------- |
| `ws_transport` | `false` | Master switch. When `true`, models listed in `ws_models` go over the plugin-owned WebSocket transport. **Independent of `ua_override`.** |
| `ws_models`    | `["gpt-5.6-sol"]` | Which models to force over WebSocket. |
| `ua_version`   | `"999.999.999"`   | The `codex_cli_rs/<version>` version sent on both the HTTP and WS paths. The gate is `>= minimum`, so a high value never needs bumping. |

The plugin injects `service_tier: "priority"` automatically for every model in `ws_models`, so you do **not** set it in config (opencode's model schema has no request-body field for it anyway). Define the reasoning gears with the `variants` **object** (keyed by id, using `reasoningEffort`) as shown above — `low, medium, high, xhigh, max` (default `medium`); `ultra` is rejected.

`ws_transport` is decoupled from `ua_override` by design: `ua_override` forges identity on the **HTTP** path (gpt-5.5 / terra / luna), while `ws_transport` switches the **transport** for WS-only models. Enable whichever you need — they do not depend on each other. The WebSocket handshake always carries the `codex_cli_rs` identity itself, so `ws_transport` works standalone.

Debug the same way as feature 2: set `OPENCODE_RESIDENCY_DEBUG=1` and sol requests log `WS transport for gpt-5.6-sol`.

## License

MIT
