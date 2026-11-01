"use client";

import { LoaderCircle, RefreshCw } from "lucide-react";
import type { ModelOption, ProviderId } from "@/lib/workspace";
import { isLocalProvider } from "@/lib/workspace";

export type { ModelOption } from "@/lib/workspace";

export default function ModelPicker({ provider, value, models = [], label, disabled = false, loading = false, hasKey = false, onChange, onRead }: {
  provider: ProviderId;
  value: string;
  models?: ModelOption[];
  label: string;
  disabled?: boolean;
  loading?: boolean;
  hasKey?: boolean;
  onChange: (value: string) => void;
  onRead: () => void;
}) {

  const listed = models.some(model => model.id === value);
  const local = isLocalProvider(provider);
  return <div className="model-picker">
    {!local && hasKey && !models.length && !loading ? <input aria-label={label} value={value} disabled={disabled} placeholder="读取列表，或填写模型 ID" onChange={e => onChange(e.target.value)} /> : <select aria-label={label} value={value} title={value || undefined} disabled={disabled || loading || (!models.length && !local)} onChange={e => onChange(e.target.value)}>
      <option value="" disabled={!local}>{local ? `${provider === "codex" ? "Codex" : "Claude Code"} 默认模型` : loading ? "正在读取模型…" : !hasKey ? "先连接 API" : models.length ? "选择模型" : "先读取模型列表"}</option>
      {value && !listed && <option value={value}>{value}（当前配置）</option>}
      {models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
    </select>}
    {hasKey && <button type="button" className="model-picker-read" aria-label={`${label}：${models.length ? "刷新" : "读取"}模型列表`} title={models.length ? "刷新可用模型" : "读取可用模型"} disabled={disabled || loading} onClick={onRead}>
      {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}{!models.length && <span>读取</span>}
    </button>}
  </div>;
}
