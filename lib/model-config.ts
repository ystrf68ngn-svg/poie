import { PROVIDERS, type ApiProviderId, type ConnectionConfig, type ModelOption, type ProviderId, type ReasoningEffort, type Workspace } from "./workspace.ts";
export function connectionFor(id: ApiProviderId, connections?: Workspace["connections"]): ConnectionConfig {
  const preset = PROVIDERS[id];
  return { name: preset.name, baseUrl: preset.baseUrl, format: preset.format === "anthropic" ? "anthropic" : "openai", ...connections?.[id] };
}
export function normalizeBaseUrl(value: string): string {
  const input = value.trim();
  if (!input) throw new Error("请粘贴服务商或中转站的网址。");
  let url: URL;
  try { url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`); }
  catch { throw new Error("网址无法识别，请重新复制服务商或中转站的链接。"); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol === "http:" && !url.port) url.protocol = "https:";
  if (url.protocol !== "https:" || url.username || url.password || url.search || (url.port && url.port !== "443")) throw new Error("请填写不含密钥、查询参数的 HTTPS 服务网址。");
  if (!host.includes(".") || /(?:^|\.)(localhost|local|internal|test|invalid)$/.test(host) || host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) throw new Error("请使用公网 HTTPS API 域名。");
  url.hash = "";
  url.pathname = url.pathname.replace(/\/(chat\/completions|messages|models|responses)\/?$/, "").replace(/\/+$/, "");
  // Common relay console links point to the website, not an API prefix.
  if (/^\/(?:console|dashboard|login|register|pricing|billing|account|settings|tokens?|docs|documentation)(?:\/|$)/i.test(url.pathname)) url.pathname = "/";
  return url.toString().replace(/\/$/, "");
}
export function apiBaseCandidates(value: string): string[] {
  const base = normalizeBaseUrl(value), url = new URL(base);
  // Preserve explicit endpoints, versioned routes, and provider-specific prefixes.
  if (/\/(?:chat\/completions|messages|models|responses)\/?(?:#.*)?$/.test(value.trim()) || /(?:^|\/)v\d+(?:[a-z\d.-]*)(?:\/|$)/i.test(url.pathname)) return [base];
  return url.pathname === "/" ? [base, `${base}/v1`, `${base}/api/v1`, `${base}/api`] : [base, `${base}/v1`];
}
export const EFFORT_LABELS: Record<ReasoningEffort, string> = { auto: "接口默认", none: "关闭思考", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最大", ultra: "超高" };
export function reasoningOptions(provider: ProviderId, model: string, models: ModelOption[], format = "openai"): ReasoningEffort[] {
  const info = models.find(m => m.id === model) || (!model ? models.find(m => m.isDefault) : undefined);
  if (info?.reasoningEfforts) return ["auto", ...info.reasoningEfforts.filter(x => x !== "auto")];
  if (provider === "codex") return ["auto"];
  if (provider === "claude-code") return ["auto", "low", "medium", "high"];
  if (/deepseek/i.test(model)) return ["auto", "none", "low", "high", "max"];
  if (format === "anthropic") return /claude.*(?:3[.-]5|3[.-]haiku|3[.-]opus)/i.test(model) ? ["auto"] : ["auto", "low", "medium", "high"];
  return ["auto", "low", "medium", "high"];
}
export function reasoningPayload(model: string, effort: ReasoningEffort = "auto", anthropic = false): Record<string, unknown> {
  if (effort === "auto") return {};
  if (anthropic) {
    if (!["low", "medium", "high"].includes(effort)) throw new Error("此接口的思考强度请选择低、中或高。");
    if (/(?:claude-3[.-]7|claude-(?:sonnet|opus)-4(?:[.-][015](?:-|$)|-20[0-9]{6}$|$)|claude-4[.-][015](?:-|$))/i.test(model)) return { thinking: { type: "enabled", budget_tokens: effort === "low" ? 1024 : effort === "medium" ? 4096 : 6144 } };
    return { thinking: { type: "adaptive" }, output_config: { effort } };
  }
  if (/deepseek/i.test(model)) {
    if (effort === "none") return { thinking: { type: "disabled" } };
    if (!["low", "high", "max"].includes(effort)) throw new Error("DeepSeek 思考强度请选择低、高或最大。");
    return { thinking: { type: "enabled" }, reasoning_effort: effort };
  }
  return { reasoning_effort: effort };
}
