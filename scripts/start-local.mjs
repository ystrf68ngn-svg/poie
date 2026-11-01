import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const failed = error => { console.error("poie启动失败：" + error.message); process.exitCode = 1; };
function start() {
  const server = spawn(process.execPath, ["--experimental-strip-types", "scripts/local-server.mjs"], { cwd: root, stdio: ["inherit", "pipe", "inherit"] });
  let opened = false;
  server.stdout.on("data", bytes => {
    process.stdout.write(bytes);
    if (!opened && bytes.toString().includes("poie已启动") && process.env.TONGPIN_NO_OPEN !== "1") {
      opened = true;
      const url = `http://127.0.0.1:${Number(process.env.TONGPIN_PORT || 4318)}/`;
      const child = process.platform === "darwin" ? spawn("open", [url], { stdio: "ignore" }) : process.platform === "win32" ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { stdio: "ignore" }) : spawn("xdg-open", [url], { stdio: "ignore" });
      child.on("error", () => console.log(`请手动在浏览器打开 ${url}`)); child.unref();
    }
  });
  server.on("error", failed);
  const stop = () => server.kill("SIGTERM");
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  server.on("exit", status => { process.exitCode = status || 0; });
}
try {
  await access(join(root, "node_modules/zod"));
  let source = true; try { await access(join(root, "node_modules/vite/bin/vite.js")); } catch { source = false; }
  if (source) {
    const build = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "vite.local.config.ts"], { cwd: root, stdio: "inherit" });
    build.on("error", failed); build.on("exit", code => { if (code !== 0) process.exitCode = code || 1; else start(); });
  } else { await access(join(root, "dist/local/index.html")); start(); }
} catch { failed(new Error("请先在项目目录运行 npm install，或使用独立运行包中的启动入口。")); }
