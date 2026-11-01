import { spawn, execFile } from "node:child_process";
import { access, mkdtemp, writeFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { promisify } from "node:util";
import { findCodex, codexEnv, codexStatus } from "./codex-chat.mjs";
import { normalizeTokenUsage, codexQuota } from "../lib/usage.ts";
import { cliConversationInput } from "../lib/conversation-turn.ts";
const exec = promisify(execFile);
let claudeBinary;
export function resetClaudeConnection() { claudeBinary = undefined; }
export function claudeEnv() {
  const env = { ...process.env, DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_MAX_RETRIES: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDECODE"]) delete env[key];
  return env;
}
export async function findClaude() {
  if (claudeBinary) return claudeBinary;
  const paths = [process.env.TONGPIN_CLAUDE_BIN, process.env.TONGPIN_TOOLS_DIR && join(process.env.TONGPIN_TOOLS_DIR, process.platform === "win32" ? "claude.exe" : "claude"), join(homedir(), ".local/bin", process.platform === "win32" ? "claude.exe" : "claude")];
  try { paths.push(...(await exec(process.platform === "win32" ? "where.exe" : "which", ["claude"], { windowsHide: true })).stdout.trim().split(/\r?\n/)); } catch {}
  for (const path of paths.filter(Boolean)) { if (process.platform === "win32" && /\.(cmd|bat)$/i.test(path)) continue; try { await access(path, constants.X_OK); claudeBinary = path; return path; } catch {} }
  throw new Error("尚未安装 Claude Code。请按官方安装指南安装，然后登录自己的 Claude 账号。");
}
export async function claudeStatus() {
  try {
    const binary = await findClaude();
    const { stdout } = await exec(binary, ["--setting-sources", "user", "auth", "status"], { env: claudeEnv(), timeout: 15000, maxBuffer: 65536, windowsHide: true });
    const result = JSON.parse(stdout);
    const authenticated = result.loggedIn === true && ["claude.ai", "oauth_token"].includes(result.authMethod);
    return { available: true, authenticated, message: authenticated ? "已连接本机 Claude Code 订阅账号" : "请使用 claude auth login 登录 Claude 订阅账号。API 连接请在下方单独配置。" };
  } catch { return { available: !!claudeBinary, authenticated: false, message: claudeBinary ? "Claude Code 尚未登录，或版本不支持 auth status。请登录或更新后再检测。" : "尚未安装 Claude Code。可先使用任意 API，或安装 Claude Code 后连接。" }; }
}
export async function claudeModels() {
  const status = await claudeStatus(); if (!status.authenticated) throw new Error(status.message);
  // Official CLI aliases are resolved by the user's CLI; this is not an entitlement claim.
  return ["sonnet", "opus", "haiku"].map(id => ({ id, name: `${id[0].toUpperCase() + id.slice(1)} · CLI 别名`, reasoningEfforts: id === "haiku" ? [] : ["low", "medium", "high"] }));
}
let claudeActive = 0;
export async function runClaudeChat(body, signal) {
  if (body.model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,149}$/.test(body.model)) throw new Error("Claude Code 模型 ID 格式不正确。");
  if (claudeActive >= 2) throw new Error("Claude Code 正在回复，请稍后再试。");
  const status = await claudeStatus(); if (!status.authenticated) throw new Error(status.message);
  signal.throwIfAborted(); claudeActive++;
  const cwd = await mkdtemp(join(tmpdir(), "tongpin-claude-"));
  try {
    // Keep official user-account authentication, but never load project/local settings.
    const args = ["-p", "--output-format", "json", "--no-session-persistence", "--tools", "", "--disallowedTools", "*", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "user", "--settings", '{"disableAllHooks":true,"autoMemoryEnabled":false}', "--system-prompt", body.system];
    if (body.model) args.push("--model", body.model);
    if (body.reasoning && body.reasoning !== "auto") {
      if (!["low", "medium", "high", "xhigh", "max"].includes(body.reasoning)) throw new Error("Claude Code 不支持该思考强度。");
      args.push("--effort", body.reasoning);
    }
    return await new Promise((resolve, reject) => {
      const child = spawn(claudeBinary, args, { cwd, env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let output = "", failed = false, killTimer;
      const stop = () => { child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 2000); killTimer.unref(); };
      signal.addEventListener("abort", stop, { once: true });
      child.stderr.on("data", () => {}); child.stdin.on("error", () => {}); child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => { output += chunk; if (output.length > 2000000) { failed = true; stop(); } });
      child.on("error", () => { signal.removeEventListener("abort", stop); reject(new Error("Claude Code 无法启动，请更新本机 CLI。")); });
      child.on("close", code => {
        signal.removeEventListener("abort", stop); clearTimeout(killTimer);
        if (signal.aborted) return reject(new DOMException("已停止或超时。", "AbortError"));
        let result; try { result = JSON.parse(output); if (Array.isArray(result)) result = result.findLast(e => e.type === "result"); } catch {}
        if (code || failed || !result || result.is_error || result.subtype !== "success" || !result.result?.trim()) return reject(new Error("Claude Code 未完成回复。请在官方 CLI 检查登录、套餐额度、所选模型和网络后重试。"));
        resolve(body.includeUsage ? { text: result.result, usage: normalizeTokenUsage(result.usage || {}, true) } : result.result);
      });
      child.stdin.end(`这是 poie 群聊中的一次回复，没有本机工具权限。\n${cliConversationInput(body.messages)}`);
      if (signal.aborted) stop();
    });
  } finally { claudeActive--; await rm(cwd, { recursive: true, force: true }); }
}
export async function readCodexQuota(signal) {
  const status = await codexStatus(); if (!status.authenticated) throw new Error(status.message);
  const binary = await findCodex();
  const raw = await new Promise((resolve, reject) => {
    const child = spawn(binary, ["app-server", "--listen", "stdio://"], { env: codexEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buffer = "", settled = false, killTimer;
    const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 2000); killTimer.unref(); err ? reject(err) : resolve(value); };
    const abort = () => finish(new Error("额度查询已取消。"));
    const timer = setTimeout(() => finish(new Error("Codex 额度查询超时。")), 25000);
    signal.addEventListener("abort", abort, { once: true });
    const send = value => child.stdin.write(JSON.stringify(value) + "\n");
    child.stderr.on("data", () => {}); child.stdin.on("error", () => {});
    child.on("error", () => finish(new Error("无法启动 Codex 额度查询。")));
    child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => {
      buffer += chunk; if (buffer.length > 1000000) return finish(new Error("额度返回内容异常。"));
      let n; while ((n = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.id === 1) { if (event.error) return finish(new Error("请更新 Codex 后读取用量。")); send({ method: "initialized" }); send({ id: 2, method: "account/rateLimits/read" }); }
        if (event.id === 2) finish(event.error ? new Error("Codex 没有返回账号用量，请检查登录与版本。") : null, event.result);
      }
    });
    child.on("close", () => { clearTimeout(killTimer); if (!settled) finish(new Error("Codex 额度连接中断。")); });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "tongpin", title: "poie", version: "0.3.0" }, capabilities: { experimentalApi: false } } });
    if (signal.aborted) abort();
  });
  return codexQuota(raw);
}
export async function openAccountLogin(provider) {
  const binary = provider === "codex" ? await findCodex() : await findClaude();
  const args = provider === "codex" ? ["login"] : ["auth", "login"];
  const folder = await mkdtemp(join(tmpdir(), "tongpin-login-"));
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  if (process.platform === "darwin") {
    const file = join(folder, "登录模型账号.command");
    const unset = provider === "codex" ? "unset OPENAI_API_KEY CODEX_API_KEY" : "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN CLAUDECODE";
    await writeFile(file, `#!/bin/sh\n${unset}\n${quote(binary)} ${args.join(" ")}\nprintf '\\n登录完成后回到poie，点击检测连接。\\n'\n`, { mode: 0o700 });
    await exec("open", ["-a", "Terminal", file]);
  } else if (process.platform === "win32") {
    if (/[&|<>^%\r\n]/.test(binary)) throw new Error("CLI 路径含特殊字符，请在终端手动登录。");
    const child = spawn("cmd.exe", ["/d", "/c", "start", '"poie账号登录"', "cmd.exe", "/k", `"${binary}"`, ...args], { env: provider === "codex" ? codexEnv() : claudeEnv(), detached: true, stdio: "ignore" }); child.unref();
  } else {
    await new Promise((resolve, reject) => { const child = spawn("x-terminal-emulator", ["-e", binary, ...args], { env: provider === "codex" ? codexEnv() : claudeEnv(), detached: true, stdio: "ignore" }); child.once("error", () => reject(new Error(`无法打开终端，请手动运行 ${provider === "codex" ? "codex login" : "claude auth login"}。`))); child.once("spawn", () => { child.unref(); resolve(); }); });
  }
  return { message: "已打开官方 CLI 登录窗口。完成登录后，回到poie点击「检测连接」。" };
}
