import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { handleChat, handleModels, modelRequestSchema } from "../lib/model-api.ts";
import { codexStatus, codexModels, runCodexChat } from "./codex-chat.mjs";
import { claudeStatus, claudeModels, runClaudeChat, readCodexQuota, openAccountLogin } from "./account-connections.mjs";
import { createProjectRuntime } from "./project-runtime.mjs";
import { handleApiUsage } from "../lib/usage.ts";
import { isLocalProvider } from "../lib/workspace.ts";
import { createWebResearch, researchSchema } from "./web-research.mjs";
const ROOT = resolve(fileURLToPath(new URL("../dist/local/", import.meta.url)));
export const SITE_ORIGIN = "https://agent-circle-xiong-1022.fond-stork-2652.chatgpt.site";
export function createLocalServer({ port = 4318, fetcher = fetch, research = createWebResearch(), staticRoot = ROOT, bridgeToken = "", trustedOrigins = [SITE_ORIGIN, "http://127.0.0.1:5173", "http://localhost:5173"], status = codexStatus, models = codexModels, chat = runCodexChat, claude = { status: claudeStatus, models: claudeModels, chat: runClaudeChat }, quota = readCodexQuota, login = openAccountLogin, runtime = createProjectRuntime() } = {}) {
  const origins = new Set(trustedOrigins);
  const controllers = new Set();
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "no-store");
    const actualPort = server.address()?.port || port;
    const localOrigins = [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`];
    const allowedOrigin = value => origins.has(value) || localOrigins.includes(value);
    if (bridgeToken && req.headers["x-tongpin-session"] !== bridgeToken) { res.writeHead(403); return res.end(); }
    if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(req.headers.host)) { res.writeHead(403); return res.end(); }
    if (origin && !allowedOrigin(origin)) { res.writeHead(403); return res.end(); }
    if (origin) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Tongpin-Client");
      res.setHeader("Access-Control-Allow-Private-Network", "true"); res.writeHead(204); return res.end();
    }
    const sendJson = (value, code = 200) => { if (!res.destroyed) { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); } };
    const controller = new AbortController(); controllers.add(controller);
    res.on("close", () => { controllers.delete(controller); if (!res.writableEnded) controller.abort(); });
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === "GET" && ["/api/claude-code/status", "/api/claude-code/models", "/api/project/status"].includes(url.pathname)) {
        if (req.headers["x-tongpin-client"] !== "tongpin") return sendJson({ error: "无效客户端。" }, 403);
        try { return sendJson(url.pathname === "/api/project/status" ? await runtime.handle(url.pathname, {}, controller.signal) : url.pathname.endsWith("/models") ? { models: await claude.models(controller.signal) } : await claude.status()); } catch (error) { return sendJson({ error: error.message }, 502); }
      }
      if (url.pathname === "/api/codex/status" && req.method === "GET") {
        if (req.headers["x-tongpin-client"] !== "tongpin") return sendJson({ error: "无效客户端。" }, 403);
        return sendJson(await status());
      }
      if (url.pathname === "/api/codex/models" && req.method === "GET") {
        if (req.headers["x-tongpin-client"] !== "tongpin") return sendJson({ error: "无效客户端。" }, 403);
        try { return sendJson({ models: await models(controller.signal) }); } catch (error) { return sendJson({ error: error.message || "读取 Codex 模型失败。" }, 502); }
      }
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "POST") return sendJson({ error: "不支持的请求。" }, 405);
        if (!origin || !allowedOrigin(origin) || req.headers["x-tongpin-client"] !== "tongpin") return sendJson({ error: "请求来源不匹配。" }, 403);
        if (!req.headers["content-type"]?.startsWith("application/json")) return sendJson({ error: "需要 JSON 请求。" }, 415);
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > (url.pathname === "/api/memory/import" ? 2000000 : 180000)) return sendJson({ error: "请求内容过长。" }, 413); chunks.push(chunk); }
        const raw = Buffer.concat(chunks);
        const request = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw, signal: controller.signal });
        if (url.pathname === "/api/research") {
          const input = researchSchema.safeParse(JSON.parse(raw));
          if (!input.success) return sendJson({ error: "请提供公开检索词或网页地址。" }, 400);
          res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
          const emit = event => { if (!res.destroyed && !controller.signal.aborted) res.write(JSON.stringify(event) + "\n"); };
          try { const result = await research(input.data, AbortSignal.any([controller.signal, AbortSignal.timeout(100000)]), message => emit({ type: "progress", message })); emit({ type: "result", result }); }
          catch (e) { emit({ type: "error", error: e.name === "TimeoutError" ? "联网读取超时，请缩小查询范围或提供报告网址。" : e.message || "联网读取失败。" }); }
          if (!res.destroyed) res.end(); return;
        }
        if (/^\/api\/(memory|skills|project)\//.test(url.pathname)) {
          try { return sendJson(await runtime.handle(url.pathname, JSON.parse(raw), AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]))); } catch (error) { return sendJson({ error: error.name === "ZodError" ? "请检查输入内容与授权选项。" : error.message }, 400); }
        }
        if (url.pathname === "/api/accounts/login") {
          const data = JSON.parse(raw); if (!["codex", "claude-code"].includes(data.provider)) return sendJson({ error: "不支持的本机账号。" }, 400);
          try { return sendJson(await login(data.provider)); } catch (error) { return sendJson({ error: error.message }, 400); }
        }
        if (url.pathname === "/api/usage") {
          const data = JSON.parse(raw); if (data.consent !== true) return sendJson({ error: "需要先同意读取用量信息。" }, 403);
          if (data.provider === "codex") { try { return sendJson(await quota(controller.signal)); } catch (error) { return sendJson({ error: error.message }, 502); } }
          if (data.provider === "claude-code") return sendJson({ kind: "unavailable", checkedAt: new Date().toISOString(), message: "Claude Code 未提供可用的订阅剩余额度查询接口。授权后的每次真实 Token 用量会显示在下方；套餐剩余额度请打开官方用量页。", link: "https://claude.ai/settings/usage" });
        }
        if (url.pathname === "/api/chat") {
          const body = modelRequestSchema.safeParse(JSON.parse(raw.toString("utf8")));
          if (!body.success) return sendJson({ error: "请检查模型设置和消息内容。" }, 400);
          if (isLocalProvider(body.data.provider)) {
            res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
            try {
              const result = await (body.data.provider === "codex" ? chat : claude.chat)(body.data, AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]));
              const text = typeof result === "string" ? result : result.text;
              if (!controller.signal.aborted && !res.destroyed) res.end(JSON.stringify({ type: "delta", text }) + "\n" + JSON.stringify({ type: "done", ...(body.data.includeUsage && result.usage ? { usage: result.usage } : {}) }) + "\n");
            } catch (error) { if (!res.destroyed) res.end(JSON.stringify({ type: "error", error: error.message || "Codex 回复失败。" }) + "\n"); }
            return;
          }
        }
        const response = url.pathname === "/api/chat" ? await handleChat(request, fetcher) : url.pathname === "/api/models" ? await handleModels(request, fetcher) : url.pathname === "/api/usage" ? await handleApiUsage(request, fetcher) : null;
        if (!response) return sendJson({ error: "接口不存在。" }, 404);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) { const reader = response.body.getReader(); try { while (true) { const { done, value } = await reader.read(); if (done || res.destroyed) break; res.write(value); } } finally { await reader.cancel().catch(() => {}); } }
        if (!res.destroyed) res.end(); return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson({ error: "不支持的请求。" }, 405);
      let path = resolve(staticRoot, "." + decodeURIComponent(url.pathname));
      const inside = relative(staticRoot, path);
      if (inside.startsWith("..") || isAbsolute(inside)) return sendJson({ error: "无效路径。" }, 400);
      if (url.pathname === "/") path = resolve(staticRoot, "index.html");
      try { if (!(await stat(path)).isFile()) throw new Error(); } catch { return sendJson({ error: "本地页面尚未构建，请使用「启动poie.command」启动。" }, 404); }
      const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" }[extname(path)] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, "X-Frame-Options": "DENY" }); res.end(req.method === "HEAD" ? undefined : await readFile(path));
    } catch { if (!res.headersSent) sendJson({ error: "请求无效，请重试。" }, 400); else if (!res.destroyed) res.end(); }
    finally { if (res.writableEnded) controllers.delete(controller); }
  });
  server.requestTimeout = 200000;
  const stop = () => { for (const c of controllers) c.abort(); server.close(); server.closeAllConnections(); };
  return { server, stop };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.TONGPIN_PORT || 4318);
  const { server, stop } = createLocalServer({ port });
  server.on("error", error => { console.error(error.code === "EADDRINUSE" ? `poie已在运行，打开 http://127.0.0.1:${port}/ 即可。` : "本机连接服务启动失败：" + error.message); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => console.log(`poie已启动： http://127.0.0.1:${port}/\n用普通浏览器打开即可。任选 API 或本机账号，不需要 ChatGPT。保持此窗口开启，按 Ctrl+C 退出。`));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
