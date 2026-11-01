import type { ModelRequest } from "./model-api.ts";
import type { ResearchBundle } from "./research.ts";
import { isLocalProvider, type LocalProviderId, type TokenUsage } from "./workspace.ts";

export const LOCAL_APP_URL = "http://127.0.0.1:4318";
export const CLIENT_HEADERS = { "Content-Type": "application/json", "X-Tongpin-Client": "tongpin" };
export type CodexConnection = { available: boolean; authenticated: boolean; message: string; checking?: boolean };
export function codexEndpoint(path: string) {
  if (typeof window !== "undefined" && window.location.protocol === "tongpin:") return path;
  const local = typeof window !== "undefined" && ["127.0.0.1", "localhost"].includes(window.location.hostname) && window.location.port !== "5173";
  return `${local ? "" : LOCAL_APP_URL}${path}`;
}
export async function getCodexConnection(provider: LocalProviderId = "codex"): Promise<CodexConnection> {
  try {
    const response = await fetch(codexEndpoint(`/api/${provider}/status`), { headers: { "X-Tongpin-Client": "tongpin" }, signal: AbortSignal.timeout(18000) });
    if (!response.ok) throw new Error();
    const data = await response.json() as CodexConnection;
    if (typeof data.authenticated !== "boolean") throw new Error();
    return data;
  } catch { return { available: false, authenticated: false, message: "尚未连接poie本机服务。请运行项目中的启动入口，再点检测连接。" }; }
}
export async function readChatStream(response: Response, onDelta?: (text: string) => void, onUsage?: (usage: TokenUsage) => void): Promise<string> {
  if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: string }; throw new Error(data.error || `连接失败（${response.status}）。`); }
  if (!response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) throw new Error("聊天服务返回格式不正确，请更新本机服务或刷新页面。");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", text = "", completed = false;
  function consume(line: string) {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "error") throw new Error(event.error || "模型回复失败。");
    if (event.type === "delta" && typeof event.text === "string") { text += event.text; if (text.length > 160000) throw new Error("回复过长，请分段提问。"); onDelta?.(text); }
    if (event.type === "done") { completed = true; if (event.usage) onUsage?.(event.usage); }
  }
  try {
    while (true) {
      const { done, value } = await reader.read(); buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline; while ((newline = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
      if (buffer.length > 1000000) throw new Error("回复数据过大。");
      if (done) { consume(buffer); break; }
    }
    if (!completed || !text.trim()) throw new Error("回复尚未完成，连接已中断。请重试。");
    return text;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function requestChat(body: ModelRequest, signal: AbortSignal, onDelta?: (text: string) => void, onUsage?: (usage: TokenUsage) => void) {
  let response: Response;
  try {
    response = await fetch(isLocalProvider(body.provider) ? codexEndpoint("/api/chat") : "/api/chat", { method: "POST", headers: CLIENT_HEADERS, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(190000)]) });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(isLocalProvider(body.provider) ? "本机账号连接中断或超时，请确认本机服务正在运行后重试。" : "连接模型服务失败或超时，请检查网络后重试。");
  }
  return readChatStream(response, onDelta, onUsage);
}
export async function localRequest<T = any>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(codexEndpoint(path), { method: body === undefined ? "GET" : "POST", headers: CLIENT_HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal || AbortSignal.timeout(60000) });
  const data = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(data.error || "本机服务请求失败。"); return data;
}
export async function requestResearch(input: { queries: string[]; urls: string[]; market?: { count: number; symbols?: string[] } }, signal: AbortSignal, progress: (text: string) => void): Promise<ResearchBundle> {
  let response: Response;
  try { response = await fetch(codexEndpoint('/api/research'), { method: 'POST', headers: CLIENT_HEADERS, body: JSON.stringify(input), signal: AbortSignal.any([signal, AbortSignal.timeout(110000)]) }); }
  catch (error) { if (signal.aborted) throw error; throw new Error('联网检索服务未连接或超时。请使用最新版 poie 桌面应用，或启动本机服务。'); }
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('联网检索服务不可用，请更新并重新打开 poie。');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', result: ResearchBundle | undefined, size = 0;
  function consume(line: string) {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') throw new Error(event.error || '检索失败。');
    if (event.type === 'progress') progress(String(event.message).slice(0, 180));
    if (event.type === 'result' && Array.isArray(event.result?.sources)) result = event.result;
  }
  try {
    while (true) {
      const { done, value } = await reader.read(); size += value?.byteLength || 0;
      if (size > 500000) throw new Error('检索结果过大。');
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end; while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (done) { consume(buffer); break; }
    }
    signal.throwIfAborted();
    if (!result) throw new Error('检索连接中断，未获得完整资料。');
    return result;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
