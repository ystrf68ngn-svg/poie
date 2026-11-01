import { spawn } from "node:child_process";
import { mkdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const env = join(root, ".tongpin/python");
const python = join(env, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const run = (bin, args) => new Promise((resolve, reject) => { const child = spawn(bin, args, { cwd: root, stdio: "inherit" }); child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(`安装进程退出：${code}`))); });
try {
  await mkdir(join(root, ".tongpin"), { recursive: true, mode: 0o700 });
  try { await access(python); } catch { await run(process.env.TONGPIN_PYTHON || (process.platform === "win32" ? "python" : "python3"), ["-m", "venv", env]); }
  // Dense-only Qdrant needs no FastEmbed model download or external database.
  await run(python, ["-m", "pip", "install", "--disable-pip-version-check", "hy-memory==2.0.4", "qdrant-client==1.20.0"]);
  console.log("Hy-Memory 2.0.4 已安装到此项目的 .tongpin/python。请在「技能与记忆」配置 Embedding 服务后启用语义检索。");
} catch (error) { console.error("安装未完成：" + error.message + "。需要 Python 3.11–3.13 和网络连接。本地文本记忆仍可使用。"); process.exitCode = 1; }
