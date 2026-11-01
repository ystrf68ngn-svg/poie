import { spawn, execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizeTokenUsage } from "../lib/usage.ts";
import { cliConversationInput } from "../lib/conversation-turn.ts";
const execFileAsync = promisify(execFile);
const DISABLED_FEATURES = ["shell_tool", "unified_exec", "apps", "plugins", "remote_plugin", "hooks", "browser_use", "computer_use", "multi_agent", "image_generation", "view_image", "skill_search", "workspace_dependencies", "code_mode_host", "memories"];
let executable, cachedStatus, cachedAt = 0;
export function resetCodexConnection() { executable = undefined; cachedStatus = undefined; cachedAt = 0; cachedModels = undefined; }
export async function findCodex() {
  if (executable) return executable;
  const candidates = [process.env.TONGPIN_CODEX_BIN, process.env.TONGPIN_TOOLS_DIR && join(process.env.TONGPIN_TOOLS_DIR, process.platform === "win32" ? "codex.exe" : "codex")];
  try { candidates.push((await execFileAsync(process.platform === "win32" ? "where.exe" : "which", ["codex"], { windowsHide: true })).stdout.trim().split(/\r?\n/)[0]); } catch {}
  for (const app of ["/Applications/Codex.app", "/Applications/ChatGPT.app", join(homedir(), "Desktop/ChatGPT.app"), join(homedir(), "Applications/Codex.app")]) {
    candidates.push(join(app, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"), join(app, "Contents/Resources/codex"));
  }
  for (const path of candidates.filter(Boolean)) { if (process.platform === "win32" && /\.(cmd|bat)$/i.test(path)) continue; try { await access(path, constants.X_OK); executable = path; return path; } catch {} }
  throw new Error("未找到本机 Codex。请先安装并登录 Codex，或设置 TONGPIN_CODEX_BIN。");
}
export function codexEnv() {
  const env = { ...process.env };
  // Use Codex's saved ChatGPT sign-in, never an API key inherited from a terminal.
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
  delete env.CODEX_THREAD_ID; delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  return env;
}
export async function codexStatus() {
  if (cachedStatus && Date.now() - cachedAt < 15000) return cachedStatus;
  let status;
  try {
    const binary = await findCodex();
    const result = await execFileAsync(binary, ["login", "status"], { timeout: 15000, maxBuffer: 65536, env: codexEnv(), windowsHide: true });
    const authenticated = /Logged in using ChatGPT/i.test(result.stdout + result.stderr);
    status = { available: true, authenticated, message: authenticated ? "已连接本机 Codex，使用已有 ChatGPT 登录" : "请先在 Codex 中登录 ChatGPT。" };
  } catch (error) { status = { available: !!executable, authenticated: false, message: executable ? "Codex 尚未登录或登录已失效，请在 Codex 中重新登录。" : error.message }; }
  cachedStatus = status; cachedAt = Date.now(); return status;
}
let active = 0;
const queue = [];
async function acquire(signal) {
  signal.throwIfAborted();
  if (active < 2) { active++; return; }
  if (queue.length >= 8) throw new Error("Codex 正在处理较多消息，请稍后再试。");
  await new Promise((resolve, reject) => {
    const entry = { resolve: () => { signal.removeEventListener("abort", onAbort); resolve(); } };
    const onAbort = () => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); reject(new DOMException("已停止", "AbortError")); };
    signal.addEventListener("abort", onAbort, { once: true }); queue.push(entry);
  });
}
function release() { const next = queue.shift(); if (next) next.resolve(); else active--; }
export async function runCodexChat(body, signal) {
  if (body.model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,149}$/.test(body.model)) throw new Error("Codex 模型 ID 格式不正确。");
  const status = await codexStatus(); if (!status.authenticated) throw new Error(status.message);
  await acquire(signal); let cwd;
  try {
    signal.throwIfAborted(); cwd = await mkdtemp(join(tmpdir(), "tongpin-chat-"));
    const args = ["exec", "--ignore-user-config", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", cwd, "--json", "--color", "never", "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0", "-c", "features.skip_host_skill_discovery=true"];
    for (const feature of DISABLED_FEATURES) args.push("-c", `features.${feature}=false`);
    if (body.reasoning && body.reasoning !== "auto") {
      if (!["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(body.reasoning)) throw new Error("思考强度无效。");
      args.push("-c", `model_reasoning_effort=${JSON.stringify(body.reasoning)}`);
    }
    if (body.model) args.push("--model", body.model);
    args.push("-");
    const prompt = `这是用户自用的 AI 群聊的一轮回复，不是代码仓库任务。不要调用工具或操作本机文件。\n\n【当前身份与规则】\n${body.system}\n\n${cliConversationInput(body.messages)}`;
    return await new Promise((resolve, reject) => {
      const child = spawn(awaitedBinary(), args, { cwd, env: codexEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let buffer = "", lastMessage = "", failure = "", completed = false, settled = false, killTimer, usage;
      const terminate = () => { child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 2000); killTimer.unref(); };
      const finish = (error, value) => { if (settled) return; settled = true; signal.removeEventListener("abort", onAbort); clearTimeout(killTimer); error ? reject(error) : resolve(value); };
      const onAbort = () => { terminate(); /* Wait for exit so the concurrency slot is not released early. */ };
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", () => finish(new Error("无法启动 Codex，请重新打开本机连接服务。")));
      child.stderr.on("data", () => {}); // Credentials and local diagnostics never go to the web client or logs.
      const consume = line => {
        if (!line.trim()) return;
        let event; try { event = JSON.parse(line); } catch { return; }
        if (event.type === "item.completed" && event.item?.type === "agent_message") lastMessage = event.item.text || "";
        if (event.type === "turn.completed") { completed = true; failure = ""; if (body.includeUsage) usage = normalizeTokenUsage(event.usage || {}); }
        if (event.type === "turn.failed" || (event.type === "error" && !completed)) failure = typeof event.message === "string" ? event.message : event.error?.message || "Codex 生成失败，请检查登录、可用额度或模型 ID。";
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        buffer += chunk;
        let newline; while ((newline = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
        if (buffer.length > 1000000) { failure = "Codex 返回内容过大。"; terminate(); }
      });
      child.on("close", code => {
        consume(buffer);
        if (signal.aborted) return finish(new DOMException("回复已停止或超时。", "AbortError"));
        if (failure || code !== 0 || !completed || !lastMessage.trim()) return finish(new Error(failure.slice(0, 350) || "Codex 没有完成回复。请检查网络后重试。"));
        finish(null, body.includeUsage ? { text: lastMessage, usage } : lastMessage);
      });
      child.stdin.on("error", () => {}); child.stdin.end(prompt);
      if (signal.aborted) onAbort();
    });
  } finally { release(); if (cwd) await rm(cwd, { recursive: true, force: true }); }
}
function awaitedBinary() { if (!executable) throw new Error("Codex 未连接。"); return executable; }

let cachedModels, modelsAt = 0, readingModels;
export async function codexModels(signal = new AbortController().signal) {
  signal.throwIfAborted();
  if (cachedModels && Date.now() - modelsAt < 60000) return cachedModels;
  if (!readingModels) readingModels = readCodexModels().then(models => { cachedModels = models; modelsAt = Date.now(); return models; }).finally(() => { readingModels = undefined; });
  return readingModels;
}
async function readCodexModels() {
  const binary = await findCodex();
  const status = await codexStatus(); if (!status.authenticated) throw new Error(status.message);
  return new Promise((resolve, reject) => {
    const args = ["app-server", "--listen", "stdio://"];
    for (const feature of DISABLED_FEATURES) args.push("-c", `features.${feature}=false`);
    const child = spawn(binary, args, { env: codexEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buffer = "", settled = false, models = [], cursor, rpcId = 2, killTimer;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 2000); killTimer.unref();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("读取 Codex 模型超时，请重新检测连接。")), 25000);
    const send = value => { if (!settled) child.stdin.write(JSON.stringify(value) + "\n"); };
    child.stderr.on("data", () => {}); child.stdin.on("error", () => {});
    child.on("error", () => finish(new Error("无法启动 Codex 模型连接。")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buffer += chunk; if (buffer.length > 2000000) return finish(new Error("Codex 模型列表过大。"));
      let newline; while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (!event.id) continue;
        if (event.error) return finish(new Error("Codex 未能读取可用模型，请更新或重新登录 Codex。"));
        if (event.id === 1) { send({ method: "initialized" }); send({ id: rpcId, method: "model/list", params: { limit: 100, includeHidden: false } }); }
        else if (event.id === rpcId) {
          models.push(...(event.result?.data || []).filter(m => !m.hidden && typeof m.model === "string").map(m => ({ id: m.model, name: m.displayName || m.model, isDefault: !!m.isDefault, defaultReasoningEffort: m.defaultReasoningEffort, reasoningEfforts: (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort).filter(e => ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(e)) })));
          cursor = event.result?.nextCursor;
          if (cursor && models.length < 300) send({ id: ++rpcId, method: "model/list", params: { limit: 100, cursor, includeHidden: false } });
          else if (models.length) finish(null, models); else finish(new Error("Codex 没有返回可用模型。"));
        }
      }
    });
    child.on("close", () => { clearTimeout(killTimer); if (!settled) finish(new Error("读取 Codex 模型失败，请重新启动本机服务。")); });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "tongpin", version: "0.2.0" }, capabilities: { experimentalApi: false } } });
  });
}
