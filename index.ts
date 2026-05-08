import type { Plugin } from "@opencode-ai/plugin";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// gpt-5.5 codex client UA override
// ---------------------------------------------------------------------------
// As of 2026-05-07, OpenAI's Codex backend
// (https://chatgpt.com/backend-api/codex/responses) gates `gpt-5.5` (and
// other reasoning models on the codex pathway) by an AND-gate on TWO HTTP
// request headers:
//
//   User-Agent prefix == "codex_cli_rs"  AND
//   originator        == "codex_cli_rs"
//
// If either is wrong (e.g. opencode's default UA "opencode/X.Y.Z" or
// originator "opencode"), the request enters reasoning and dies with a
// silent server_error mid-stream. Other models (gpt-5.4 etc.) are
// unaffected.
//
// The fix can't live in `chat.headers`: in opencode 1.14.39 the Vercel AI
// SDK constructs its own request and ignores hook overrides for default
// headers like User-Agent. The only effective injection point is
// globalThis.fetch — and it must be patched at module load, before any
// AI SDK fetch fires.
//
// Opt-in via opencode.json. The flag overrides BOTH `User-Agent` and
// `originator` on outgoing requests to the codex backend (OpenAI gates on
// the AND of the two), but the config key is shortened to `ua_override`:
//   "provider": { "openai": { "options": { "ua_override": true } } }
// ---------------------------------------------------------------------------

const CODEX_UA = "codex_cli_rs/0.20.0";
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_TARGET_FRAGMENTS = [
  "chatgpt.com/backend-api/codex",
  "api.openai.com",
];

// Module-level guard flag. Default OFF preserves opt-in semantics. The flag
// is flipped on by the chat.headers hook below, which receives opencode's
// own (jsonc-tolerant, path-resolved) parsed config — so we never have to
// read the config file ourselves and never have to guess where it lives.
let uaOverrideEnabled = false;

function debugLog(line: string): void {
  if (!process.env.OPENCODE_RESIDENCY_DEBUG) return;
  const target = process.env.OPENCODE_RESIDENCY_DEBUG_FILE;
  const stamp = new Date().toISOString();
  const msg = `[${stamp}] ${line}\n`;
  if (target) {
    try {
      fs.appendFileSync(target, msg);
    } catch {
      // ignore
    }
  } else {
    process.stderr.write(`opencode-openai-residency: ${msg}`);
  }
}

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

    if (!uaOverrideEnabled || !CODEX_TARGET_FRAGMENTS.some((f) => url.includes(f))) {
      return origFetch(input as RequestInfo | URL, init);
    }

    const baseHeaders =
      init?.headers ??
      (input instanceof Request ? input.headers : undefined);
    const h = new Headers(baseHeaders ?? {});
    const beforeUA = h.get("User-Agent") ?? "(unset)";
    const beforeOrig = h.get("originator") ?? "(unset)";
    for (const k of ["User-Agent", "user-agent", "USER-AGENT"]) h.delete(k);
    for (const k of ["originator", "Originator", "ORIGINATOR"]) h.delete(k);
    h.set("User-Agent", CODEX_UA);
    h.set("originator", CODEX_ORIGINATOR);
    debugLog(
      `intercepted ${url} | UA ${beforeUA} -> ${CODEX_UA} | originator ${beforeOrig} -> ${CODEX_ORIGINATOR}`,
    );

    if (input instanceof Request) {
      return origFetch(new Request(input, { headers: h }));
    }
    return origFetch(input, { ...(init ?? {}), headers: h });
  }) as typeof fetch;
}

// Module-scope side effect: install the fetch wrapper unconditionally before
// any AI SDK fetch fires. While `uaOverrideEnabled` is false (the default)
// the wrapper short-circuits to origFetch on every call — near-zero overhead.
// The chat.headers hook flips the flag once it sees opencode's parsed config.
patchFetchForCodex();

// ---------------------------------------------------------------------------
// Residency header hook (original behavior)
// ---------------------------------------------------------------------------

export const OpenAIResidencyPlugin: Plugin = async () => ({
  "chat.headers": async (input, output) => {
    if (input.model.providerID !== "openai") return;
    // Sync flag from opencode-provided, jsonc-parsed, path-resolved config.
    // This avoids the 1.1.0 bug where reading ~/.config/opencode/opencode.json
    // ourselves silently failed for: project-local configs, Windows %APPDATA%,
    // macOS ~/Library/Application Support, XDG_CONFIG_HOME overrides, and
    // jsonc files (comments/trailing commas tripping JSON.parse).
    uaOverrideEnabled = input.provider?.options?.ua_override === true;
    const residency = input.provider?.options?.enforce_residency;
    if (residency) {
      output.headers["x-openai-internal-codex-residency"] = String(residency);
    }
  },
});

export default OpenAIResidencyPlugin;
