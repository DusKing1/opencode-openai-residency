# opencode-openai-residency

[OpenCode](https://github.com/anomalyco/opencode) plugin that adds the `x-openai-internal-codex-residency` header to OpenAI Codex API requests.

This is needed for **OpenAI Enterprise** workspaces with data residency requirements (e.g. US-only). Without this header, Codex API requests from non-US regions are rejected with `401 "Workspace is not authorized in this region"`.

This mirrors exactly how the official [Codex CLI](https://github.com/openai/codex/blob/main/codex-rs/core/src/default_client.rs) handles data residency.

> **Note**: If OpenCode merges built-in residency support ([PR #15844](https://github.com/anomalyco/opencode/pull/15844)), this plugin becomes unnecessary and can be removed.

## Install

Add to your `opencode.json`:

```jsonc
{
  "plugin": ["opencode-openai-residency"],
  "provider": {
    "openai": {
      "options": {
        "enforce_residency": "us",
      },
    },
  },
}
```

Restart OpenCode. The plugin is automatically installed and loaded.

## How it works

On every LLM call to the OpenAI provider, the plugin checks `provider.options.enforce_residency` from your config. If set, it adds:

```
x-openai-internal-codex-residency: <value>
```

to the outgoing HTTP headers. If not set, it does nothing (zero impact).

## License

MIT
