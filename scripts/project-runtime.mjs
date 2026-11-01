import { readFile, writeFile, mkdir, rename, readdir, access, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { parseMemoryImport, memoryContext } from "../lib/memory.ts";
import { normalizeBaseUrl } from "../lib/model-config.ts";

const PROJECT = fileURLToPath(new URL("../", import.meta.url));
const safeId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const memorySchema = z.object({ title: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(6000), source: z.string().max(160).default("手动保存") });
const hySchema = z.object({ baseUrl: z.string().max(2048), model: z.string().min(1).max(150), dimensions: z.number().int().min(64).max(8192), apiKey: z.string().min(1).max(1024), consent: z.literal(true) });
async function atomic(path, value) { await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 }); const tmp = `${path}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await rename(tmp, path); }

export function createProjectRuntime(root = join(PROJECT, ".tongpin"), fetcher = fetch, assets = PROJECT) {
  let writeQueue = Promise.resolve(); const stage = new Map();
  const serialize = action => { const result = writeQueue.then(action); writeQueue = result.catch(() => {}); return result; };
  const folder = id => join(root, "workspaces", safeId.parse(id));
  const invalidateIndex = async id => { await rm(join(folder(id), "hy"), { recursive: true, force: true }); await rm(join(folder(id), "hy-index.json"), { force: true }); };
  const readMemories = async id => { try { return JSON.parse(await readFile(join(folder(id), "memory.json"), "utf8")); } catch (error) { if (error.code === "ENOENT") return []; throw new Error("记忆文件无法读取，请先备份项目数据。"); } };
  const python = join(root, "python", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const hyCall = async (body, signal = AbortSignal.timeout(90000)) => {
    try { await access(python); } catch { throw new Error("Hy-Memory 尚未安装，请在项目目录运行 npm run memory:install。"); }
    return new Promise((resolve, reject) => {
      const child = spawn(python, [join(assets, "scripts/hy-memory-bridge.py")], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let output = "", killTimer;
      const stop = () => { child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 2000); killTimer.unref(); };
      signal.addEventListener("abort", stop, { once: true });
      child.stderr.on("data", () => {}); child.stdin.on("error", () => {}); child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => { output += chunk; if (output.length > 2000000) stop(); });
      child.once("error", () => { signal.removeEventListener("abort", stop); reject(new Error("记忆引擎无法启动。")); });
      child.on("close", code => { clearTimeout(killTimer); signal.removeEventListener("abort", stop); let value; try { value = JSON.parse(output.trim()); } catch {} if (signal.aborted || code || !value || value.error) reject(new Error(value?.error || "记忆引擎未完成请求，请检查配置或网络。")); else resolve(value); });
      child.stdin.end(JSON.stringify(body)); if (signal.aborted) stop();
    });
  };
  const skills = async () => {
    const result = [{ id: "hy-memory", name: "Hy-Memory · 记忆迁移", source: "https://github.com/Tencent-Hunyuan/Hy-Memory", builtin: true, content: await readFile(join(assets, "project-skills/hy-memory/SKILL.md"), "utf8") }];
    let names = []; try { names = await readdir(join(root, "skills")); } catch {}
    for (const id of names) if (safeId.safeParse(id).success && id !== "hy-memory") { try { result.push({ ...JSON.parse(await readFile(join(root, "skills", id, "manifest.json"), "utf8")), content: await readFile(join(root, "skills", id, "SKILL.md"), "utf8") }); } catch {} }
    return result;
  };
  const fetchText = async url => {
    const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(25000), headers: { Accept: "application/vnd.github+json", "User-Agent": "Tongpin-Skills" } });
    if (!response.ok) throw new Error(`读取 GitHub 失败（${response.status}），请提供公开仓库的具体 Skill 文件夹。`);
    const reader = response.body.getReader(); let text = "", bytes = 0; const decoder = new TextDecoder();
    try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 2000000) throw new Error("技能目录过大，请选择具体的 Skill 子目录。"); text += decoder.decode(value, { stream: true }); } return text + decoder.decode(); } finally { await reader.cancel().catch(() => {}); }
  };
  return {
    async handle(path, body = {}, signal) {
      if (path === "/api/project/status") {
        let engine; try { engine = await hyCall({ action: "status" }, signal); } catch { engine = { installed: false }; }
        return { available: true, engine, skills: (await skills()).map(({ content, ...s }) => s) };
      }
      if (path === "/api/skills/preview") {
        const url = new URL(z.string().max(2048).parse(body.url));
        if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) throw new Error("请提供 github.com 上公开 Skill 的链接。");
        if (/^\/Tencent-Hunyuan\/Hy-Memory\/?$/i.test(url.pathname) || (url.pathname === "/search" && url.searchParams.get("q") === "hy-memory")) return { builtin: true, id: "hy-memory", name: "Hy-Memory", content: (await skills())[0].content, message: "项目已内置 Hy-Memory 适配技能。可在记忆页导入历史；语义检索需安装引擎并配置 Embedding。" };
        if (url.search || url.hash) throw new Error("请使用具体的仓库或 Skill 文件夹链接。");
        const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        const [owner, repo, kind, ref, ...rest] = segments;
        if (!/^[a-zA-Z0-9_.-]+$/.test(owner || "") || !/^[a-zA-Z0-9_.-]+$/.test(repo || "") || segments.some(x => x === ".." || x.includes("\\") || x.includes("/")) || (kind && !["tree", "blob"].includes(kind))) throw new Error("技能链接格式无效。");
        const api = `https://api.github.com/repos/${owner}/${repo}`;
        const metadata = JSON.parse(await fetchText(api)); const branch = ref || metadata.default_branch;
        const commit = JSON.parse(await fetchText(`${api}/commits/${encodeURIComponent(branch)}`));
        if (!/^[a-f0-9]{40}$/.test(commit.sha || "")) throw new Error("无法确认技能版本。");
        const pathParts = kind === "blob" ? rest.slice(0, -1) : rest;
        if (kind === "blob" && rest.at(-1) !== "SKILL.md") throw new Error("请提供 SKILL.md 或其所在文件夹。");
        const prefix = pathParts.length ? pathParts.join("/") + "/" : "";
        const tree = JSON.parse(await fetchText(`${api}/git/trees/${commit.sha}?recursive=1`));
        if (tree.truncated) throw new Error("仓库目录过大，请使用较小的技能仓库。");
        const entries = tree.tree.filter(x => x.type === "blob" && x.mode === "100644" && x.path.startsWith(prefix) && /\.(md|txt|json|py|js|mjs|sh)$/i.test(x.path));
        if (!entries.some(x => x.path === `${prefix}SKILL.md`)) throw new Error("这个文件夹没有 SKILL.md。Hy-Memory 引擎请使用已内置的专用适配器。");
        if (entries.length > 40 || entries.reduce((s, x) => s + (x.size || 0), 0) > 300000) throw new Error("技能包过大，请选择具体的 Skill 子目录（最多 40 个文本文件 / 300 KB）。");
        const files = {};
        for (const entry of entries) {
          const relative = entry.path.slice(prefix.length);
          if (relative.split("/").some(x => ["..", ".git", ".env"].includes(x)) || relative.includes("\\")) throw new Error("技能包含无效路径。");
          files[relative] = await fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/${commit.sha}/${entry.path.split("/").map(encodeURIComponent).join("/")}`);
        }
        const id = `${repo}-${pathParts.at(-1) || "skill"}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 65);
        const token = randomUUID(); const info = { id, name: id, source: url.toString(), commit: commit.sha, files, content: files["SKILL.md"], at: Date.now() };
        for (const [key, value] of stage) if (Date.now() - value.at > 600000) stage.delete(key);
        if (stage.size >= 10) stage.delete(stage.keys().next().value);
        stage.set(token, info);
        return { token, id, name: id, source: info.source, commit: info.commit, content: info.content, files: Object.keys(files), notice: "安装到此项目。启用后会把技能说明发送给当前模型；脚本文件只保存，不自动执行。" };
      }
      if (path === "/api/skills/install") return serialize(async () => {
        if (body.consent !== true) throw new Error("请先确认技能来源与内容。");
        const info = stage.get(body.token); if (!info || Date.now() - info.at > 600000) throw new Error("预览已过期，请重新读取技能。");
        const dest = join(root, "skills", safeId.parse(info.id));
        try { await access(join(dest, "manifest.json")); throw new Error("此技能已经安装，未覆盖现有版本。"); } catch (error) { if (error.code !== "ENOENT") throw error; }
        for (const [name, content] of Object.entries(info.files)) { const file = join(dest, name); await mkdir(resolve(file, ".."), { recursive: true, mode: 0o700 }); await writeFile(file, content, { mode: 0o600 }); }
        await atomic(join(dest, "manifest.json"), { id: info.id, name: info.name, source: info.source, commit: info.commit, installedAt: new Date().toISOString() }); stage.delete(body.token);
        return { installed: true, id: info.id };
      });
      const workspaceId = safeId.parse(body.workspaceId);
      if (path === "/api/memory/list") return { items: await readMemories(workspaceId) };
      if (path === "/api/memory/import") return serialize(async () => {
        if (body.consent !== true) throw new Error("请预览并确认后再导入记忆。");
        const imported = parseMemoryImport(z.string().max(600000).parse(body.text), z.string().max(150).parse(body.filename));
        const saved = await readMemories(workspaceId); const seen = new Set(saved.map(x => x.text)); const next = [...saved];
        for (const m of imported) if (!seen.has(m.text)) { next.push({ ...m, id: randomUUID(), createdAt: new Date().toISOString() }); seen.add(m.text); }
        if (next.length > 2000) throw new Error("当前工作空间最多保存 2000 条记忆，请先整理或导出。");
        await atomic(join(folder(workspaceId), "memory.json"), next); if (next.length !== saved.length) await invalidateIndex(workspaceId); return { added: next.length - saved.length, items: next };
      });
      if (path === "/api/memory/save") return serialize(async () => {
        const item = memorySchema.parse(body.item); parseMemoryImport(item.text, "记忆.txt");
        const saved = await readMemories(workspaceId); const index = body.id ? saved.findIndex(x => x.id === body.id) : -1;
        if (body.id && index < 0) throw new Error("记忆已删除，请刷新列表。");
        if (index < 0 && saved.length >= 2000) throw new Error("记忆已达上限，请先整理。");
        const value = { ...item, id: index < 0 ? randomUUID() : saved[index].id, createdAt: index < 0 ? new Date().toISOString() : saved[index].createdAt };
        if (index < 0) saved.push(value); else saved[index] = value;
        await atomic(join(folder(workspaceId), "memory.json"), saved); await invalidateIndex(workspaceId); return { item: value };
      });
      if (path === "/api/memory/delete") return serialize(async () => { const id = safeId.parse(body.id); const saved = (await readMemories(workspaceId)).filter(x => x.id !== id); await atomic(join(folder(workspaceId), "memory.json"), saved); await invalidateIndex(workspaceId); return { deleted: true }; });
      if (path === "/api/memory/index") return serialize(async () => {
        const config = hySchema.parse(body.config); config.baseUrl = normalizeBaseUrl(config.baseUrl);
        const items = await readMemories(workspaceId);
        if (!items.length) throw new Error("请先保存或导入记忆。");
        // Immutable generation prevents stale/deleted memories from leaking through an old vector index.
        const generation = createHash("sha256").update(JSON.stringify([items, config.baseUrl, config.model, config.dimensions])).digest("hex").slice(0, 24);
        const directory = join(folder(workspaceId), "hy", generation);
        await invalidateIndex(workspaceId);
        const result = await hyCall({ action: "add", items, config, directory, workspaceId }, signal);
        await atomic(join(folder(workspaceId), "hy-index.json"), { generation, baseUrl: config.baseUrl, model: config.model, dimensions: config.dimensions, indexedAt: new Date().toISOString() });
        return { indexed: result.items.length, message: "Hy-Memory 已完成索引。启用本群记忆后，使用该 Embedding 配置召回。" };
      });
      if (path === "/api/project/context") {
        const selected = (await skills()).filter(s => Array.isArray(body.skillIds) && body.skillIds.includes(s.id));
        let instructions = "";
        for (const skill of selected.slice(0, 4)) {
          instructions += `\n【用户在本群启用的技能：${skill.name}】\n${skill.content.slice(0, 4500)}\n`;
          if (!skill.builtin) { let refs = []; try { refs = await readdir(join(root, "skills", skill.id, "references")); } catch {} for (const name of refs.filter(n => /^[\w.-]+\.md$/.test(n)).slice(0, 2)) instructions += (await readFile(join(root, "skills", skill.id, "references", name), "utf8")).slice(0, 1500); }
        }
        if (!body.memoryEnabled) return { instructions: instructions.slice(0, 10000), memory: "", mode: "off" };
        const items = await readMemories(workspaceId); const query = z.string().max(60000).parse(body.query || "");
        let memory = memoryContext(items, query), mode = "local-text", warning;
        if (body.hyConfig?.consent === true) {
          try {
            const config = hySchema.parse(body.hyConfig); config.baseUrl = normalizeBaseUrl(config.baseUrl);
            const generation = createHash("sha256").update(JSON.stringify([items, config.baseUrl, config.model, config.dimensions])).digest("hex").slice(0, 24);
            const current = JSON.parse(await readFile(join(folder(workspaceId), "hy-index.json"), "utf8"));
            if (current.generation !== generation) throw new Error("记忆或 Embedding 配置已更改，请重新建立 Hy-Memory 索引。");
            const result = await serialize(() => hyCall({ action: "search", query, config, directory: join(folder(workspaceId), "hy", generation), workspaceId }, signal));
            const records = result.memories?.normal || [];
            memory = records.map(m => typeof m.content === "string" ? m.content : "").filter(Boolean).join("\n\n").slice(0, 6500); mode = "hy-memory";
          } catch (error) { warning = error.message; }
        }
        return { instructions: instructions.slice(0, 10000), memory, mode, warning, count: items.length };
      }
      throw new Error("项目接口不存在。");
    },
  };
}
