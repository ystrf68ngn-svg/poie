import { contentParts } from './artifacts.ts';
import type { Task } from './workspace.ts';
import type { MarketDataset } from './market-data.ts';

export type StoredDeliverable = { id: string; filename: string; mime: 'application/pdf'; size: number };
export type TaskReceipt = { state: 'complete' | 'blocked' | 'partial'; summary: string; missing: string[] };
export type TaskAssessment = { state: 'done' | 'blocked' | 'review'; reason: string; records?: number; datasetId?: string };
export const TASK_RECEIPT_INSTRUCTION = '交付正文后，在最后单独附加一个 poie-status 代码块，内容为 JSON，例如：{"state":"complete","summary":"一句话交付说明","missing":[]}。state 只能是 complete、blocked、partial 三者之一。只有实际交付满足要求才能 complete，且 missing 必须为空数组；脚本未执行、缺少真实数据、只有模板必须 blocked 或 partial，并列出缺失项。报告正文可交由桌面平台实际渲染 PDF，不能提前声称文件已生成。该代码块由平台解析，不用于显示推理。';
export function taskRequirements(task: Pick<Task, 'title' | 'description'>) {
  const text = task.title + ' ' + task.description;
  return { dataset: /采集|收集|获取|collect|fetch/i.test(text) && /股价|行情|股票.{0,8}数据|stock.{0,8}(?:price|data)/i.test(text), minimumRows: Number(text.match(/(\d{1,4})\s*(?:条|只|行)/)?.[1] || 0), chart: /图表|制图|作图|树状图|treemap|chart/i.test(task.title), pdf: /pdf/i.test(task.title + ' ' + task.description) };
}
export function readTaskResponse(raw: string): { text: string; receipt?: TaskReceipt } {
  const match = /\n?```poie-status\s*\n([\s\S]*?)\n```\s*$/i.exec(raw);
  if (!match) return { text: raw.trim() };
  const text = raw.slice(0, match.index).trim();
  try {
    const receipt = JSON.parse(match[1]);
    if (!['complete', 'blocked', 'partial'].includes(receipt.state) || typeof receipt.summary !== 'string' || !Array.isArray(receipt.missing) || receipt.missing.some((v: unknown) => typeof v !== 'string')) return { text };
    return { text, receipt: { state: receipt.state, summary: receipt.summary.slice(0, 180), missing: receipt.missing.slice(0, 8).map((s: string) => s.slice(0, 180)) } };
  } catch { return { text }; }
}
export function explicitBlock(text: string) {
  const lead = text.replace(/```[\s\S]*?```/g, '').slice(0, 600);
  return /任务受阻|未取得任何.{0,10}(?:数据|行情)|没有向.{0,12}交付任何数值|(?:有效)?行情数据(?:为|：|=|条数为)?\s*[0０零]\s*条|未形成.{0,12}(?:成品|真实行情)|(?:未|无法|不能)(?:实际)?(?:完成采集|取得行情|生成PDF|生成 PDF)/i.test(lead);
}
export function assessTask(task: Pick<Task, 'title' | 'description'>, text: string, receipt?: TaskReceipt, datasets: MarketDataset[] = [], files: StoredDeliverable[] = []): TaskAssessment {
  if (receipt?.state === 'blocked' || explicitBlock(text)) return { state: 'blocked', reason: receipt?.missing.join('；') || receipt?.summary || '成员正文说明交付受阻，尚未取得实际成果。' };
  const required = taskRequirements(task), dataset = datasets.find(d => d.kind === 'cn-a-quotes');
  if (required.dataset && (!dataset || dataset.stale || dataset.rows.length < Math.max(dataset.requested, required.minimumRows) || dataset.missing.length)) return { state: 'blocked', reason: dataset ? `有效行情 ${dataset.rows.length}/${Math.max(dataset.requested, required.minimumRows)} 条${dataset.stale && dataset.dataDate ? '，数据过旧' : ''}，未满足采集条件。` : '没有本轮结构化行情数据；股票清单、搜索摘要和未运行脚本不计为行情。', records: dataset?.rows.length || 0 };
  if (required.chart && !contentParts(text).some(p => p.artifact && p.artifact.kind !== 'code' && /<svg[\s>]|<canvas[\s>]/i.test(p.artifact.source))) return { state: 'blocked', reason: '没有实际图表文件；文字描述或制图脚本不能代替图表。' };
  if (required.pdf && !files.some(f => f.mime === 'application/pdf' && f.size > 4)) return { state: 'blocked', reason: 'PDF 文件尚未实际生成；可打印 HTML 或“已完成”说明不能代替 PDF。' };
  if (!receipt || receipt.state === 'partial' || receipt.missing.length) return { state: 'review', reason: receipt?.missing.join('；') || '已收到成员回复，尚未确认满足全部交付条件。' };
  if (text.trim().length < 10) return { state: 'review', reason: '没有足够的具体交付内容。' };
  return { state: 'done', reason: required.dataset && dataset ? `已取得并传递 ${dataset.rows.length} 条行情，数据日期 ${dataset.dataDate}。` : required.pdf ? 'PDF 已实际生成，可下载。' : '已返回具体交付，文件条件检查通过。', ...(dataset ? { records: dataset.rows.length, datasetId: dataset.id } : {}) };
}
export function taskBrief(title: string, assessment: TaskAssessment) {
  return `${assessment.state === 'done' ? '已交付' : assessment.state === 'blocked' ? '受阻' : '待确认'}：${title}。${assessment.reason}`;
}
export function reportDocument(title: string, text: string, upstream: string[] = []) {
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const charts = upstream.flatMap(answer => contentParts(answer).flatMap(part => part.artifact ? [...part.artifact.source.matchAll(/<svg[\s\S]*?<\/svg>/gi)].map(m => m[0]) : [])).slice(0, 3);
  const document = contentParts(text).find(p => p.artifact?.kind === 'html');
  if (document?.artifact) {
    const html = document.artifact.source;
    const appendix = charts.filter(svg => !html.includes(svg)).map(svg => `<section style="break-inside:avoid;max-width:100%">${svg.replace(/<svg\b/, '<svg style="max-width:100%;height:auto"')}</section>`).join('');
    return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, appendix + '</body>') : html + appendix;
  }
  return `<html lang="zh-CN"><head><style>@page{size:A4;margin:18mm}body{font:13px/1.65 -apple-system,"Microsoft YaHei",sans-serif;color:#222}h1{font-size:22px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}svg{max-width:100%;height:auto}section{break-inside:avoid}</style></head><body><h1>${escape(title)}</h1><pre>${escape(text)}</pre>${charts.map(svg => `<section>${svg}</section>`).join('')}</body></html>`;
}
