# Bug: `ua_override` silently no-ops when opencode config isn't at `~/.config/opencode/opencode.json`

> Affected version: **1.1.0**
> Repro environment: opencode 1.14.x, `@opencode-ai/plugin` 1.4.x

## Symptom

User installs `opencode-openai-residency@1.1.0` and sets:

```jsonc
{
  "plugin": ["opencode-openai-residency@latest"],
  "provider": {
    "openai": {
      "options": {
        "enforce_residency": "us",
        "ua_override": true
      }
    }
  }
}
```

- `enforce_residency: "us"` ✅ works (region header injected, request passes).
- `ua_override: true` ❌ does **not** work (gpt-5.5 still dies mid-stream with silent `server_error`; default `opencode/...` UA still on the wire).

A separate hand-written plugin (`~/.config/opencode/plugins/gpt55-useragent.ts`) with **structurally identical fetch-patch code** works fine on the same opencode install. So the patch mechanism itself is sound — the issue is the gating logic.

## Root cause

The two features read config through **different channels**:

**Residency (works)** — [`index.ts:125-133`](./index.ts#L125-L133), via `chat.headers` hook:

```ts
"chat.headers": async (input, output) => {
  const residency = input.provider?.options?.enforce_residency;
  // ...
}
```

opencode resolves the config path itself, parses **jsonc**, and hands the plugin a pre-parsed object. Reliable.

**UA override (broken)** — [`index.ts:41-50`](./index.ts#L41-L50), via direct file read:

```ts
function isUaOverrideEnabled(): boolean {
  try {
    const cfgPath = path.join(os.homedir(), ".config/opencode/opencode.json");
    const raw = fs.readFileSync(cfgPath, "utf8");
    const cfg = JSON.parse(raw);
    return cfg?.provider?.openai?.options?.ua_override === true;
  } catch {
    return false;            // ← swallows all errors → patch never installs
  }
}
```

This breaks for any of:

1. **Config in a different path**
   - Windows native: `%APPDATA%\opencode\opencode.json`
   - macOS native: `~/Library/Application Support/opencode/opencode.json`
   - `XDG_CONFIG_HOME` override → opencode follows it, this plugin doesn't
   - Project-local: `./opencode.json` (very common)

2. **Config is jsonc** (comments / trailing commas) — `JSON.parse` throws → catch → `false`. opencode itself uses a jsonc parser, so `enforce_residency` keeps working through the hook while `ua_override` silently dies. **This perfectly matches the reported symptom.**

3. Read permission issues, symlink edge cases, BOM, etc.

When this fails, the `globalThis.fetch` patch is never installed, requests go out with default `opencode/X.Y.Z` UA, and OpenAI's `codex_cli_rs` AND-gate rejects them.

The contrast with the working ad-hoc plugin (`gpt55-useragent.ts`) is illuminating: it has the same hardcoded-path bug, but its `catch` fallback is `return true` (default-on opt-out) instead of `return false` (default-off opt-in). Config-read failures go unnoticed there because the user-set flag isn't actually consulted.

## Proposed fix: source the flag from the hook, not the disk

Don't compete with opencode's own config resolver. Install the fetch patch unconditionally at module load with a guard flag; let the `chat.headers` hook (which already receives parsed config from opencode) flip the flag.

```ts
// Module-level state, default off — opt-in semantics preserved.
let uaOverrideEnabled = false;

function patchFetchForCodex(): void {
  const g = globalThis as { __opencodeOpenAIResidencyFetchPatched?: boolean };
  if (g.__opencodeOpenAIResidencyFetchPatched) return;
  g.__opencodeOpenAIResidencyFetchPatched = true;
  debugLog("fetch patch installed");

  const origFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = "";
    try {
      url =
        typeof input === "string"
          ? input
          : input instanceof URL
          ? input.href
          : (input as Request)?.url ?? "";
    } catch {
      return origFetch(input as RequestInfo | URL, init);
    }

    // Pass through unless flag is on AND URL is in scope.
    if (!uaOverrideEnabled || !CODEX_TARGET_FRAGMENTS.some((f) => url.includes(f))) {
      return origFetch(input as RequestInfo | URL, init);
    }

    // ... existing header rewrite logic, unchanged ...
  }) as typeof fetch;
}

// Install unconditionally at module load. No more disk reads.
patchFetchForCodex();

export const OpenAIResidencyPlugin: Plugin = async () => ({
  "chat.headers": async (input, output) => {
    if (input.model.providerID !== "openai") return;

    // Sync the flag from opencode-provided, jsonc-parsed config.
    uaOverrideEnabled = input.provider?.options?.ua_override === true;

    const residency = input.provider?.options?.enforce_residency;
    if (residency) {
      output.headers["x-openai-internal-codex-residency"] = String(residency);
    }
  },
});
```

Net diff: delete `isUaOverrideEnabled()`, delete the module-bottom `if (isUaOverrideEnabled()) patchFetchForCodex()` block, add the flag + the one-line flag update inside the existing hook.

## Why this works

- **`chat.headers` runs before the request fetch** for every OpenAI chat call → flag is correct before any codex request fires. The very first chat call sets it; the patch's URL filter discards anything non-codex anyway.
- **Jsonc-tolerant** — opencode parses the config, not `JSON.parse`.
- **No more path guessing** — config resolution is opencode's job, not the plugin's.
- **Same opt-in surface** — `ua_override: true` still required, default off, same scope (`chatgpt.com/backend-api/codex` + `api.openai.com`).

## Edge cases considered

- **Pre-chat OpenAI fetches** (model list, auth probe, etc.) fire before any `chat.headers` hook → they go out with the default UA. This is actually correct: OpenAI's `codex_cli_rs` gate is only on the chat streaming endpoint. Spoofing unrelated calls was never required and is arguably noisier.
- **User toggles `ua_override` mid-session** — now reflected on the next chat call. Free improvement over the current "decided at module load forever" behavior.
- **Non-OpenAI providers** — hook early-returns before touching the flag; fetch URL filter ignores their requests anyway.
- **Race on the first chat call** — none in practice: opencode awaits the `chat.headers` hook before constructing the request.
- **Plugin loaded but feature unused** — fetch wrapper short-circuits on `uaOverrideEnabled === false` for every URL, near-zero overhead.

## Diagnostic for affected users (current 1.1.0)

```bash
# Linux/macOS
OPENCODE_RESIDENCY_DEBUG=1 OPENCODE_RESIDENCY_DEBUG_FILE=/tmp/r.log opencode

# Windows PowerShell
$env:OPENCODE_RESIDENCY_DEBUG=1
$env:OPENCODE_RESIDENCY_DEBUG_FILE="$env:TEMP\residency.log"
opencode
```

After one chat request to a gated model:

| Log content | Diagnosis |
|---|---|
| File missing / empty | `isUaOverrideEnabled()` returned `false` → config-read mismatch confirmed |
| `fetch patch installed` only, no `intercepted ...` | Patch installed but request bypassed `globalThis.fetch` (opencode internals changed?) |
| `intercepted ... -> codex_cli_rs/0.20.0` present | Plugin doing its job; failure is downstream (TLS/payload fingerprinting?) |

In every reported case so far, it's the first row.
