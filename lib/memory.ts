export type MemoryItem = { id: string; title: string; text: string; source: string; createdAt: string };
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
export function parseMemoryImport(input: string, filename: string): Pick<MemoryItem, "title" | "text" | "source">[] {
  if (input.length > 600000) throw new Error("单个记忆文件最多 600 KB，请分批导入。");
  let items: { title: string; text: string; source: string }[] = [];
  const add = (text: unknown, title?: unknown, source?: unknown) => {
    const value = clean(text); if (!value) return;
    for (let i = 0; i < value.length; i += 6000) items.push({ title: (clean(title) || filename).slice(0, 120), text: value.slice(i, i + 6000), source: (clean(source) || filename).slice(0, 160) });
  };
  const messageText = (m: any) => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p.text || "").filter(Boolean).join("\n") : Array.isArray(m.content?.parts) ? m.content.parts.filter((p: unknown) => typeof p === "string").join("\n") : clean(m.text);
  const visit = (data: any, depth = 0) => {
    if (depth > 8) throw new Error("记忆文件层级过深。");
    if (Array.isArray(data)) { for (const value of data) visit(value, depth + 1); return; }
    if (!data || typeof data !== "object") return;
    if (data.mapping && typeof data.mapping === "object") {
      // ChatGPT exports are trees. Follow the current branch instead of including deleted/regenerated alternatives.
      const chain: any[] = []; const seen = new Set(); let cursor = data.current_node;
      while (cursor && data.mapping[cursor] && !seen.has(cursor)) { seen.add(cursor); const node = data.mapping[cursor]; if (node.message) chain.unshift(node.message); cursor = node.parent; }
      const messages = chain.length ? chain : Object.values(data.mapping).map((n: any) => n.message).filter(Boolean);
      add(messages.filter((m: any) => ["user", "assistant"].includes(m.author?.role)).map((m: any) => `${m.author.role}：${messageText(m)}`).join("\n\n"), data.title, "ChatGPT 导出"); return;
    }
    const messages = data.chat_messages || data.messages;
    if (Array.isArray(messages)) { add(messages.filter((m: any) => ["user", "assistant", "human"].includes(m.role || m.sender)).map((m: any) => `${m.role || m.sender}：${messageText(m)}`).join("\n\n"), data.title || data.name, data.source || "聊天导出"); return; }
    if (data.type === "response_item" && data.payload?.type === "message" && ["user", "assistant"].includes(data.payload.role)) { add(`${data.payload.role}：${messageText(data.payload)}`, "Codex 对话", "Codex 导出"); return; }
    if (data.message && ["user", "assistant"].includes(data.message.role)) { add(`${data.message.role}：${messageText(data.message)}`, "Claude Code 对话", "Claude Code 导出"); return; }
    const text = clean(data.text) || clean(data.content) || clean(data.memory) || clean(data.statement);
    if (text) { add(text, data.title || data.name, data.source); return; }
    for (const key of ["items", "memories", "vdb", "normal", "schema", "proactive", "profile", "data", "records", "snapshot"]) if (data[key]) visit(data[key], depth + 1);
  };
  if (/\.jsonl$/i.test(filename)) { for (const line of input.split(/\r?\n/).filter(x => x.trim())) { try { visit(JSON.parse(line)); } catch { throw new Error("JSONL 包含无效记录，请检查导出文件。"); } } }
  else if (/\.json$/i.test(filename) || /^[\[{]/.test(input.trim())) { let data; try { data = JSON.parse(input); } catch { throw new Error("JSON 格式不正确。"); } visit(data); }
  else if (/\.(md|txt)$/i.test(filename)) { for (const part of input.split(/\n\s*\n/)) add(part); }
  else throw new Error("请选择 JSON、JSONL、Markdown 或 TXT 记忆导出文件。");
  items = [...new Map(items.map(x => [x.text, x])).values()];
  if (!items.length) throw new Error("没有识别到记忆内容。支持poie、Hy-Memory、ChatGPT、Claude 导出及 Markdown/TXT。");
  if (items.length > 300) throw new Error("一次最多导入 300 条记忆，请分批导入。");
  if (items.some(x => /\bsk-[a-zA-Z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(x.text))) throw new Error("文件中包含疑似密钥。请移除密钥后再导入记忆。");
  return items;
}
export function memoryContext(items: MemoryItem[], query: string): string {
  const tokens = new Set((query.toLowerCase().match(/[a-z0-9_-]{2,}|[\u3400-\u9fff]/g) || []));
  const ranked = items.map((item, index) => ({ item, index, score: [...tokens].reduce((n, token) => n + (item.text.toLowerCase().includes(token) ? 1 : 0), 0) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.index - a.index);
  let remaining = 6500;
  return ranked.slice(0, 6).map(({ item }) => { const text = item.text.slice(0, Math.min(2000, remaining)); remaining -= text.length; return text ? `来源：${item.title}（${item.source}）\n${text}` : ""; }).filter(Boolean).join("\n\n");
}
