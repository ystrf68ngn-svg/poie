import { z } from "zod";
import { REASONING_EFFORTS, PROVIDERS, isLocalProvider } from "./workspace.ts";
import { normalizeTokenUsage } from "./usage.ts";

import { normalizeBaseUrl, apiBaseCandidates, reasoningPayload } from "./model-config.ts";

const connectionFields = { baseUrl: z.string().trim().max(2048).optional(), format: z.enum(["openai", "anthropic"]).optional() };
const providerSchema = z.enum(["anthropic", "gemini", "deepseek", "qwen", "moonshot", "custom"]);
export const modelRequestSchema = z.object({
  ...connectionFields,
  reasoning: z.enum(REASONING_EFFORTS).default("auto"),
  provider: z.enum(["codex", "claude-code", "anthropic", "gemini", "deepseek", "qwen", "moonshot", "custom"]),
  includeUsage: z.boolean().optional(),
  model: z.string().trim().max(150).default(""),
  apiKey: z.string().trim().max(1024).optional(),
  system: z.string().max(32000),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(60000) })).min(1).max(40),
}).superRefine((body, ctx) => {
  if (!isLocalProvider(body.provider) && (!body.apiKey?.trim() || !body.model.trim())) ctx.addIssue({ code: "custom", message: "请填写 API Key 和模型 ID。" });
});
export type ModelRequest = z.infer<typeof modelRequestSchema>;
export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
export const streamHeaders = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Accel-Buffering": "no" };
export async function readBody(request: Request, max = 180000): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new Error("请发送 JSON 请求。");
  const reader = request.body?.getReader(); if (!reader) throw new Error("请求不能为空。");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > max) { await reader.cancel(); throw new Error("请求过长，请缩短内容。"); } chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
function headersFor(provider: string, apiKey: string): Record<string, string> {
  return provider === "anthropic" ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}
async function upstreamError(response: Response, apiKey: string) {
  const errors: Record<number, string> = { 400: "请求参数或模型 ID 不正确", 401: "API Key 无效", 402: "账户余额不足", 403: "密钥或地区没有访问权限", 404: "模型或接口不存在", 429: "额度不足或请求过于频繁" };
  let detail = "";
  try { const data = await response.json() as { error?: { message?: string } | string; message?: string }; detail = typeof data.error === "string" ? data.error : data.error?.message || data.message || ""; } catch { /* Do not relay an HTML error page. */ }
  detail = detail.split(apiKey).join("[已隐藏密钥]").slice(0, 240);
  return `${errors[response.status] || "模型服务暂时不可用"}（${response.status}）${detail ? `：${detail}` : "。"}`;
}
export async function* sseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader(); const decoder = new TextDecoder(); let buffer = "", data: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
        if (!line) { if (data.length) { yield data.join("\n"); data = []; } }
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (buffer.length > 1000000) throw new Error("模型返回的数据过大。");
      if (done) { if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart()); if (data.length) yield data.join("\n"); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function sameOrigin(request: Request) { const origin = request.headers.get("origin"); return !origin || origin === new URL(request.url).origin; }
function invalidApiResponse(response: Response, baseUrl: string) {
  const html = response.headers.get("content-type")?.includes("text/html");
  const url = new URL(baseUrl);
  const suggestedBaseUrl = html && url.pathname === "/" ? `${url.origin}/v1` : undefined;
  const error = html
    ? `当前地址返回的是网页，不是模型 API。${suggestedBaseUrl ? `请确认 API 基础地址是否应为 ${suggestedBaseUrl}，再读取模型。` : "请检查 API 基础地址和接口格式，使用服务商提供的 API 路径。"}`
    : "模型接口未返回有效的模型列表 JSON。请检查 API 基础地址和接口格式。";
  return json({ error, code: "MODEL_RESPONSE_FORMAT", ...(suggestedBaseUrl ? { suggestedBaseUrl } : {}) }, 502);
}
function connectionError(error: unknown, apiKey: string, provider: string, stage: string, aborted: boolean) {
  const failure = error as { name?: string; message?: string; cause?: { code?: string } };
  aborted ||= failure?.name === "TimeoutError" || failure?.name === "AbortError";
  console.error(JSON.stringify({ event: "model_connection_failed", provider, stage, name: failure?.name, message: String(failure?.message || "Unknown error").split(apiKey).join("[redacted]").slice(0, 350), code: failure?.cause?.code }));
  return json({ error: aborted ? "模型请求已取消或超时，请重试。" : "无法连接模型 API。请检查 API 地址、代理设置和服务状态后重试。", code: aborted ? "MODEL_TIMEOUT" : "MODEL_CONNECTION_FAILED" }, aborted ? 408 : 502);
}
type DiscoveredModels = { baseUrl: string; models: { id: string; name: string }[]; error?: never; catalogUnavailable?: never } | { error: Response; catalogUnavailable?: boolean; baseUrl?: never; models?: never };
async function discoverModels(bases: string[], format: string, apiKey: string, signal: AbortSignal, fetcher: typeof fetch): Promise<DiscoveredModels> {
  let lastError: Response | undefined;
  for (const baseUrl of bases) {
    signal.throwIfAborted();
    // Only probe read-only endpoints on the user's original origin. Never follow redirects with a key.
    const response = await fetcher(`${baseUrl}/models`, { headers: headersFor(format, apiKey), redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return { error: json({ error: "模型接口发生重定向，请使用服务商提供的最终连接网址。", code: "MODEL_REDIRECT" }, 502) }; }
    if (!response.ok) {
      const failure = json({ error: await upstreamError(response, apiKey) }, 422);
      if (![404, 405].includes(response.status)) return { error: failure };
      lastError = failure; continue;
    }
    let data: { data?: { id?: string; display_name?: string; name?: string }[] } | null;
    try { data = await response.json(); } catch { lastError = invalidApiResponse(response, baseUrl); continue; }
    if (!Array.isArray(data?.data)) { lastError = invalidApiResponse(response, baseUrl); continue; }
    const models = data.data.filter(m => typeof m?.id === "string" && !/embedding|rerank|tts|whisper|transcribe|imagen|veo|live-/i.test(m.id)).slice(0, 150).map(m => ({ id: m.id!, name: m.display_name || m.name || m.id! }));
    return { models, baseUrl };
  }
  return { catalogUnavailable: true, error: bases.length === 1 && lastError ? lastError : json({ error: "未能从这个链接识别出模型接口。请确认这是服务商的连接网址，或粘贴其提供的完整 API 地址。", code: "MODEL_API_NOT_FOUND" }, 502) };
}
export async function handleChat(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "请求来源不匹配。" }, 403);
  let body: ModelRequest;
  try { body = modelRequestSchema.parse(await readBody(request)); } catch { return json({ error: "请检查 API Key、模型 ID 和消息内容。" }, 400); }
  if (isLocalProvider(body.provider)) return json({ error: "本机账号需要poie本机服务。请运行项目中的启动入口。" }, 409);
  const provider = PROVIDERS[body.provider], apiKey = body.apiKey!;
  let baseUrl: string;
  try { baseUrl = normalizeBaseUrl(body.baseUrl ?? provider.baseUrl); } catch (error) { return json({ error: error instanceof Error ? error.message : "API 地址不正确。" }, 400); }
  const anthropic = (body.format || provider.format) === "anthropic";
  let reasoning: Record<string, unknown>;
  try { reasoning = reasoningPayload(body.model, body.reasoning, anthropic); } catch (error) { return json({ error: (error as Error).message }, 400); }
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(180000)]);
  const payload = anthropic ? { ...reasoning, model: body.model, max_tokens: 8192, stream: true, system: body.system, messages: body.messages } : { ...reasoning, model: body.model, stream: true, ...(body.includeUsage ? { stream_options: { include_usage: true } } : {}), messages: [{ role: "system", content: body.system }, ...body.messages] };
  let response: Response;
  try {
    // Older saved connections or manually entered models can still contain a homepage URL.
    // Resolve it using GETs before sending the conversation, so a paid chat is never retried.
    const suppliedUrl = body.baseUrl ?? provider.baseUrl;
    const bases = apiBaseCandidates(suppliedUrl);
    if (bases.length > 1 && (body.provider === "custom" || baseUrl !== provider.baseUrl)) {
      const discovered = await discoverModels(bases, anthropic ? "anthropic" : "openai", apiKey, AbortSignal.any([signal, AbortSignal.timeout(25000)]), fetcher);
      if (!discovered.error) baseUrl = discovered.baseUrl;
      else if (!discovered.catalogUnavailable) return discovered.error;
      // Some APIs allow chat but do not expose a catalog. Keep their explicit original route usable.
    }
    // Workers supports manual redirects; reject a redirect response without forwarding credentials.
    response = await fetcher(`${baseUrl}/${anthropic ? "messages" : "chat/completions"}`, { method: "POST", headers: headersFor(anthropic ? "anthropic" : "openai", apiKey), body: JSON.stringify(payload), redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) return json({ error: "模型接口发生重定向，请检查供应商接口配置。", code: "MODEL_REDIRECT" }, 502);
    if (!response.ok) return json({ error: await upstreamError(response, apiKey) }, response.status >= 500 ? 502 : 422);
    if (response.headers.get("content-type")?.includes("text/html")) { await response.body?.cancel(); return invalidApiResponse(response, baseUrl); }
    if (!response.body) return json({ error: "模型没有返回内容。" }, 502);
  } catch (error) { return connectionError(error, apiKey, body.provider, "chat", signal.aborted); }
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async start(out) {
      const emit = (event: unknown) => { if (!controller.signal.aborted) out.enqueue(encoder.encode(JSON.stringify(event) + "\n")); };
      let text = "", completed = false, usage: Record<string, unknown> = {};
      try {
        for await (const raw of sseData(response.body!)) {
          if (signal.aborted) throw new Error("回复已取消或超时。");
          if (raw === "[DONE]") { completed = true; break; }
          const event = JSON.parse(raw);
          if (body.includeUsage) usage = { ...usage, ...(event.message?.usage || {}), ...(event.usage || {}) };
          if (event.error) throw new Error((typeof event.error === "string" ? event.error : event.error.message || "模型返回错误。").split(apiKey).join("[已隐藏密钥]"));
          const finish = anthropic ? event.delta?.stop_reason : event.choices?.[0]?.finish_reason;
          if (finish === "length" || finish === "max_tokens") throw new Error("回复达到长度上限，已保留生成的部分，可以请模型继续。");
          if (finish || event.type === "message_stop") completed = true;
          const delta = anthropic ? (event.type === "content_block_delta" && event.delta?.type === "text_delta" ? event.delta.text : "") : event.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) { text += delta; if (text.length > 150000) throw new Error("回复过长，已保留生成的部分。"); emit({ type: "delta", text: delta }); }
        }
        if (!completed) throw new Error("连接中断，回复尚未完成，请重新发送。");
        if (!text.trim()) throw new Error("模型返回了空内容，请更换模型或重试。");
        emit({ type: "done", ...(body.includeUsage ? { usage: normalizeTokenUsage(usage, anthropic) } : {}) });
      } catch (error) { emit({ type: "error", error: error instanceof Error ? error.message.slice(0, 350) : "生成失败，请重试。" }); }
      finally { if (!controller.signal.aborted) out.close(); controller.abort(); }
    },
    cancel() { controller.abort(); },
  }), { headers: streamHeaders });
}
export async function handleModels(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "请求来源不匹配。" }, 403);
  let body: { provider: z.infer<typeof providerSchema>; apiKey: string; baseUrl?: string; format?: "openai" | "anthropic" };
  try { body = z.object({ ...connectionFields, provider: providerSchema, apiKey: z.string().trim().min(1).max(1024) }).parse(await readBody(request, 8192)); } catch { return json({ error: "请先填写该厂商的 API Key。" }, 400); }
  let bases: string[];
  try { bases = apiBaseCandidates(body.baseUrl ?? PROVIDERS[body.provider].baseUrl); } catch (error) { return json({ error: (error as Error).message }, 400); }
  const format = body.format || PROVIDERS[body.provider].format;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25000)]);
  try {
    const result = await discoverModels(bases, format, body.apiKey, signal, fetcher);
    if (result.error) return result.error;
    return result.models.length ? json(result) : json({ baseUrl: result.baseUrl, error: "已识别连接，但没有读到可用的聊天模型。可以手动填写服务商提供的模型 ID 后测试。" }, 422);
  } catch (error) { return connectionError(error, body.apiKey, body.provider, "models", signal.aborted); }
}
