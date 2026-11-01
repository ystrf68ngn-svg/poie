"use client";
import { useRef, useState, useEffect } from "react";
import { LoaderCircle, RefreshCw, ShieldCheck, ExternalLink } from "lucide-react";
import { PROVIDERS, isLocalProvider, type ApiProviderId, type ProviderId, type Workspace } from "@/lib/workspace";
import { connectionFor } from "@/lib/model-config";
import { CLIENT_HEADERS, codexEndpoint } from "@/lib/chat-client";
import type { QuotaSnapshot } from "@/lib/usage";

export default function UsagePanel({ ws, keys, commit }: { ws: Workspace; keys: Partial<Record<ApiProviderId, string>>; commit: (fn: (w: Workspace) => Workspace) => void }) {
  const [selected, setSelected] = useState<ProviderId>(ws.agents.find(a => a.id === ws.groups.find(g => g.id === ws.activeGroup)?.ownerId)?.provider || "deepseek");
  const [snapshot, setSnapshot] = useState<QuotaSnapshot>(); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  function select(id: ProviderId) { controller.current?.abort(); setSelected(id); setSnapshot(undefined); setError(""); setBusy(false); }
  const allowed = !!ws.usageConsent?.[selected];
  function authorize(enabled: boolean) { controller.current?.abort(); setBusy(false); setSnapshot(undefined); setError(""); commit(w => ({ ...w, usageConsent: { ...w.usageConsent, [selected]: enabled }, ...(!enabled ? { usage: w.usage?.filter(u => u.provider !== selected) } : {}) })); }
  async function refresh() {
    if (!allowed) return;
    const c = new AbortController(); controller.current?.abort(); controller.current = c; setBusy(true); setError("");
    try {
      if (!isLocalProvider(selected) && !keys[selected]) throw new Error("请先在模型连接中填写这个连接的 API Key。");
      const response = await fetch(isLocalProvider(selected) ? codexEndpoint("/api/usage") : "/api/usage", { method: "POST", headers: CLIENT_HEADERS, body: JSON.stringify({ provider: selected, consent: true, ...(!isLocalProvider(selected) ? { ...connectionFor(selected, ws.connections), apiKey: keys[selected] } : {}) }), signal: AbortSignal.any([c.signal, AbortSignal.timeout(35000)]) });
      const data = await response.json() as QuotaSnapshot & { error?: string }; if (!response.ok) throw new Error(data.error || "查询失败。");
      if (!c.signal.aborted) setSnapshot(data);
    } catch (error) { if (!c.signal.aborted) setError(error instanceof Error ? error.message : "查询失败。"); }
    finally { if (!c.signal.aborted) setBusy(false); }
  }
  const records = (ws.usage || []).filter(x => x.provider === selected);
  const sum = (key: "inputTokens" | "outputTokens" | "totalTokens") => { const values = records.filter(r => r[key] !== undefined); return values.length ? values.reduce((n, r) => n + r[key]!, 0).toLocaleString() : "—"; };
  return <div className="utility-panel">
    <label className="form-label">查看连接<select aria-label="用量连接" value={selected} onChange={e => select(e.target.value as ProviderId)}>{Object.entries(PROVIDERS).map(([id, p]) => <option key={id} value={id}>{isLocalProvider(id as ProviderId) ? p.name : connectionFor(id as ApiProviderId, ws.connections).name}</option>)}</select></label>
    <div className="consent-box"><ShieldCheck size={20} /><div><strong>用量信息由你决定是否读取</strong><p>同意后，poie可以查询这个连接的额度或余额，并保存之后的调用 Token 统计。不会读取其他对话。仅在点击刷新时查询账号，不自动轮询。撤回会清除这里保存的统计。</p><label className="check-line"><input type="checkbox" aria-label="同意读取此连接的用量" checked={allowed} onChange={e => authorize(e.target.checked)} />我同意读取此连接的用量信息</label></div></div>
    {!allowed ? <p className="panel-empty">尚未授权，未查询账号额度，也不会记录调用用量。</p> : <>
      <div className="panel-toolbar"><h3>账号额度 / 余额</h3><button className="button secondary" disabled={busy} onClick={refresh}>{busy ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}刷新用量</button></div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {!snapshot && !error && <p className="form-help">点击刷新后读取官方返回的信息。</p>}
      {snapshot?.windows?.map((w, i) => <div className="quota-window" key={i}><div><strong>{w.name}</strong><span>已用 {w.usedPercent}% · 剩余 {Math.max(0, 100 - w.usedPercent).toFixed(0)}%</span></div><progress value={w.usedPercent} max={100} /><small>{w.minutes ? `窗口 ${w.minutes >= 1440 ? `${w.minutes / 1440} 天` : `${w.minutes} 分钟`}` : "窗口时长未提供"}{w.resetsAt ? ` · ${new Date(w.resetsAt * 1000).toLocaleString()} 重置` : ""}</small></div>)}
      {snapshot?.balances?.map(b => <div className="balance-value" key={b.currency}><span>当前可用余额</span><strong>{b.total} <small>{b.currency}</small></strong></div>)}
      {snapshot?.message && <p className="form-help">{snapshot.message}</p>}
      {snapshot?.link === "https://claude.ai/settings/usage" && <a className="text-button" href={snapshot.link} target="_blank" rel="noreferrer">打开 Claude 官方用量页<ExternalLink size={13} /></a>}
      {snapshot && <p className="tiny-label">查询时间：{new Date(snapshot.checkedAt).toLocaleString()}</p>}
      <h3 className="settings-subtitle">poie调用统计<span>此浏览器 · 授权之后</span></h3><div className="usage-totals"><div><span>输入 Token</span><strong>{sum("inputTokens")}</strong></div><div><span>输出 Token</span><strong>{sum("outputTokens")}</strong></div><div><span>总 Token</span><strong>{sum("totalTokens")}</strong></div></div>
      <p className="form-help">仅统计服务实际返回的用量，未返回时不估算；不是账号全部历史。Token 不等于人民币或订阅剩余额度。部分中转站不支持流式用量参数，此时可撤回授权继续聊天。</p>
      <div className="usage-list">{records.slice(-20).reverse().map(r => <div key={r.id}><span>{r.model || "CLI 默认模型"}<small>{r.purpose === "compression" ? "上下文整理 · " : r.purpose === "research" ? "检索准备 · " : ""}{new Date(r.time).toLocaleString()}</small></span><strong>{r.totalTokens?.toLocaleString() ?? "—"} Token</strong></div>)}</div>
    </>}
  </div>;
}
