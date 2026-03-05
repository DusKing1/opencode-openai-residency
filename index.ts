import type { Plugin } from "@opencode-ai/plugin";

export const OpenAIResidencyPlugin: Plugin = async () => ({
  "chat.headers": async (input, output) => {
    if (input.model.providerID !== "openai") return;
    const residency = input.provider?.options?.enforce_residency;
    if (residency) {
      output.headers["x-openai-internal-codex-residency"] = String(residency);
    }
  },
});

export default OpenAIResidencyPlugin;
