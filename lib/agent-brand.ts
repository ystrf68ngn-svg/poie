import type { Agent, ProviderId } from "./workspace.ts";

const BRANDS = {
  openai: { name: "OpenAI", image: "/model-logos/openai.png" },
  claude: { name: "Claude", image: "/model-logos/claude.png" },
  gemini: { name: "Gemini", image: "/model-logos/gemini.png" },
  deepseek: { name: "DeepSeek", image: "/model-logos/deepseek.png" },
  qwen: { name: "Qwen", image: "/model-logos/qwen.png" },
  kimi: { name: "Kimi", image: "/model-logos/kimi.png" },
} as const;

const PROVIDER_BRANDS: Partial<Record<ProviderId, keyof typeof BRANDS>> = {
  codex: "openai", "claude-code": "claude", anthropic: "claude",
  gemini: "gemini", deepseek: "deepseek", qwen: "qwen", moonshot: "kimi",
};

// A relay's connection name does not determine the model's manufacturer.
export function agentBrand(agent?: Pick<Agent, "provider" | "model">) {
  if (!agent) return null;
  const model = agent.model.trim().toLowerCase().split("/").at(-1) || "";
  const modelBrand: keyof typeof BRANDS | undefined =
    /^deepseek(?:[-_.:]|$)/.test(model) ? "deepseek" :
    /^claude(?:[-_.:]|$)/.test(model) ? "claude" :
    /^gemini(?:[-_.:]|$)/.test(model) ? "gemini" :
    /^qwen(?:\d|[-_.:]|$)/.test(model) ? "qwen" :
    /^(?:kimi|moonshot)(?:[-_.:]|$)/.test(model) ? "kimi" :
    /^(?:gpt(?:[-_.:]|$)|chatgpt(?:[-_.:]|$)|codex(?:[-_.:]|$)|o\d+(?:[-_.:]|$))/.test(model) ? "openai" : undefined;
  const brand = modelBrand || PROVIDER_BRANDS[agent.provider];
  return brand ? BRANDS[brand] : null;
}
