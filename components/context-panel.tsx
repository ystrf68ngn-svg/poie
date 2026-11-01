"use client";
import { useState } from 'react';
import { Check, LoaderCircle, Pin, Sparkles } from 'lucide-react';
import type { Group } from '@/lib/workspace';
import { contextStats, CONTEXT_PINNED_CHARS, SUMMARY_SECTIONS, type ContextSummary, type GroupContext } from '@/lib/conversation-context';

export default function ContextPanel({ group, busy, status, update, compress }: { group: Group; busy: boolean; status: string; update: (patch: Partial<GroupContext>) => void; compress: () => void }) {
  const stats = contextStats(group);
  const [pinned, setPinned] = useState(group.context?.pinned || '');
  const [saved, setSaved] = useState(false);
  return <div className="context-panel">
    <div className="context-overview"><div><strong>{stats.digest ? '工作已经有了接续摘要' : '长对话会自动整理'}</strong><p>保留近期原文，把较早的目标、约束、决定和进度整理成摘要。同群成员共享，切换模型也能继续。</p></div><Sparkles size={23} /></div>
    <div className="context-counts"><span><strong>{stats.total}</strong>条有效消息</span><span><strong>{stats.covered}{stats.partial ? '+' : ''}</strong>条已整理</span><span><strong>{stats.chars.toLocaleString()}</strong>近期原文字符</span></div>
    <label className="check-line"><input type="checkbox" aria-label="自动压缩上下文" checked={group.context?.auto !== false} disabled={busy} onChange={e => update({ auto: e.target.checked })} />自动压缩上下文</label>
    <p className="form-help">超过 24 条未整理消息或约 3.2 万字符时，在回复前使用当前回复模型整理。会产生该模型的额外用量；关闭后，长对话会提示先手动整理。单条资料仍受模型和请求大小限制。</p>
    <div className="context-action"><button className="button secondary" onClick={compress} disabled={busy || stats.recent < 2}>{busy ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}立即整理</button>{status && <span role="status">{status}</span>}</div>
    <form className="context-pins" onSubmit={e => { e.preventDefault(); update({ pinned: pinned.trim() }); setSaved(true); }}><label className="form-label"><span><Pin size={14} />固定要求</span><textarea aria-label="固定要求" value={pinned} maxLength={CONTEXT_PINNED_CHARS} rows={5} disabled={busy} placeholder="例如：本地运行；优先支持中文；未经我同意不发布；验收必须展示实际效果。" onChange={e => { setPinned(e.target.value); setSaved(false); }} /></label><div><span>{pinned.length} / {CONTEXT_PINNED_CHARS} 字符 · 每轮完整带给模型</span><button className="button primary" disabled={busy || pinned.trim() === (group.context?.pinned || '')}>{saved ? <Check size={14} /> : <Pin size={14} />}{saved ? '已保存' : '保存要求'}</button></div></form>
    <section className="context-summary"><h3>接续摘要</h3>{stats.digest ? <><p className="form-help">{new Date(stats.digest.updatedAt).toLocaleString('zh-CN')} · {stats.digest.model}</p>{Object.entries(SUMMARY_SECTIONS).map(([key, title]) => <div key={key}><h4>{title}</h4><p>{stats.digest!.summary[key as keyof ContextSummary] || '暂无记录'}</p></div>)}</> : <p className="form-help">尚未生成摘要。继续聊天时会自动整理，也可以点击「立即整理」。</p>}</section>
    <p className="form-help">摘要可能遗漏细节，关键要求建议固定。原聊天记录不会因压缩而删除，可继续查看与导出；本轮会按问题找回部分相关旧消息。此功能与「技能与记忆」里的长期记忆库独立。</p>
  </div>;
}
