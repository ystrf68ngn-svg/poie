import { z } from "zod";
import type { TokenUsage } from "./workspace.ts";
import { normalizeBaseUrl } from "./model-config.ts";

const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
export function normalizeTokenUsage(raw: Record<string, any>, anthropic = false): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = number(raw.input_tokens ?? raw.prompt_tokens);
  const output = number(raw.output_tokens ?? raw.completion_tokens);
  const cached = number(raw.cached_input_tokens ?? raw.cache_read_input_tokens ?? raw.prompt_tokens_details?.cached_tokens);
  const cacheCreation = number(raw.cache_creation_input_tokens);
  const inputTokens = input === undefined ? undefined : input + (anthropic ? (cached || 0) + (cacheCreation || 0) : 0);
  const totalTokens = number(raw.total_tokens) ?? (inputTokens !== undefined && output !== undefined ? inputTokens + output : undefined);
  if ([inputTokens, output, cached, totalTokens].every(v => v === undefined)) return undefined;
  return { inputTokens, outputTokens: output, cachedTokens: cached, totalTokens };
}
export type QuotaSnapshot = { kind: "windows" | "balance" | "unavailable"; checkedAt: string; message?: string; windows?: { name: string; usedPercent: number; minutes?: number; resetsAt?: number }[]; balances?: { currency: string; total: string }[]; link?: string };
export function codexQuota(raw: any): QuotaSnapshot {
  const buckets = raw?.rateLimitsByLimitId ? Object.values(raw.rateLimitsByLimitId) : raw?.rateLimits ? [raw.rateLimits] : [];
  const windows: NonNullable<QuotaSnapshot["windows"]> = [];
  for (const bucket of buckets as any[]) for (const [label, window] of [["当前窗口", bucket.primary], ["长期窗口", bucket.secondary]] as const) {
    if (number(window?.usedPercent) !== undefined) windows.push({ name: `${bucket.limitName || bucket.limitId || "Codex"} · ${label}`, usedPercent: window.usedPercent, minutes: number(window.windowDurationMins), resetsAt: number(window.resetsAt) });
  }
  return { kind: windows.length ? "windows" : "unavailable", windows, checkedAt: new Date().toISOString(), ...(!windows.length ? { message: "服务没有返回额度窗口，不能视为剩余 100%。" } : {}) };
}
export async function handleApiUsage(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin) return reply({ error: "请求来源不匹配。" }, 403);
  let body;
  try { body = z.object({ consent: z.literal(true), baseUrl: z.string().max(2048), apiKey: z.string().min(1).max(1024) }).parse(await request.json()); } catch { return reply({ error: "需要先同意读取此连接的用量信息。" }, 403); }
  let base;
  try { base = normalizeBaseUrl(body.baseUrl); } catch { return reply({ error: "API 地址无效。" }, 400); }
  if (!/^https:\/\/api\.deepseek\.com(?:\/v1)?$/.test(base)) return reply({ kind: "unavailable", checkedAt: new Date().toISOString(), message: "此服务未接入官方余额接口。可查看已授权后的poie调用统计；剩余额度请到供应商控制台查看。" });
  try {
    const response = await fetcher("https://api.deepseek.com/user/balance", { headers: { Authorization: `Bearer ${body.apiKey}` }, redirect: "manual", signal: AbortSignal.any([request.signal, AbortSignal.timeout(20000)]) });
    if (!response.ok) return reply({ error: `DeepSeek 余额查询失败（${response.status}），请检查此连接的密钥与权限。` }, 502);
    const data = await response.json() as any;
    const balances = Array.isArray(data.balance_infos) ? data.balance_infos.filter((b: any) => ["CNY", "USD"].includes(b.currency) && /^-?\d+(\.\d+)?$/.test(b.total_balance)).map((b: any) => ({ currency: b.currency, total: b.total_balance })) : [];
    return reply({ kind: balances.length ? "balance" : "unavailable", balances, checkedAt: new Date().toISOString(), ...(!balances.length ? { message: "服务未返回可显示的余额。" } : {}) });
  } catch { return reply({ error: "查询余额超时或连接中断，请稍后重试。" }, 502); }
}
