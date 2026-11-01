export type MarketRequest = { count: number; symbols?: string[] };
export type MarketQuote = { code: string; name: string; exchange: 'SH' | 'SZ'; price: number; previousClose: number; open: number; high: number; low: number; changePercent: number; volumeLots: number; amountCny: number; rawVolumeUnit: 'shares' | 'lots'; quoteTime: string; source: string };
export type MarketDataset = { id: string; kind: 'cn-a-quotes'; requested: number; selection: string; retrievedAt: string; dataDate: string; rows: MarketQuote[]; missing: string[]; stale: boolean };

export function marketRequest(query: string, previous = ''): MarketRequest | undefined {
  if (!/股价|股票行情|每日.{0,6}股票|股市.{0,12}数据|股票.{0,10}数据|A\s*股|沪深|\bstock prices?\b/i.test(query)) return;
  if (/美股|港股|美國|美国股票|纳斯达克|nasdaq|NYSE|\bUS stocks?\b/i.test(query) && !/A\s*股|沪深|中国股/i.test(query)) return;
  const symbols = [...new Set(query.match(/(?<!\d)(?:sh|sz)?(?:60|68|00|30)\d{4}(?!\d)/gi) || [])];
  const count = query.match(/(\d{1,4})\s*(?:只|条|家|个)(?:股票|数据|记录|样本)?/)?.[1] || previous.match(/(\d{1,4})\s*(?:只|条|家|个)(?:股票|数据|记录|样本)?/)?.[1];
  return { count: symbols.length || (count ? Number(count) : 100), ...(symbols.length ? { symbols } : {}) };
}
const cell = (value: unknown) => `"${(typeof value === 'string' && /^[=+@-]/.test(value) ? "'" + value : String(value)).replaceAll('"', '""')}"`;
export function marketCsv(dataset: MarketDataset) {
  return 'code,name,exchange,price_cny,previous_close_cny,open_cny,high_cny,low_cny,change_percent,volume_lots,amount_cny,raw_volume_unit,quote_time,source\n' + dataset.rows.map(r => [r.code, r.name, r.exchange, r.price, r.previousClose, r.open, r.high, r.low, r.changePercent, r.volumeLots, r.amountCny, r.rawVolumeUnit, r.quoteTime, r.source].map(cell).join(',')).join('\n');
}
export function marketSummary(dataset: MarketDataset) {
  const rows = dataset.rows, count = rows.length;
  const ascending = [...rows].sort((a, b) => a.changePercent - b.changePercent);
  return { records: count, requested: dataset.requested, dataDate: dataset.dataDate, rising: rows.filter(r => r.changePercent > 0).length, falling: rows.filter(r => r.changePercent < 0).length, flat: rows.filter(r => r.changePercent === 0).length, meanChangePercent: count ? Number((rows.reduce((n, r) => n + r.changePercent, 0) / count).toFixed(4)) : null, top: ascending.slice(-5).reverse().map(r => ({ code: r.code, name: r.name, changePercent: r.changePercent })), bottom: ascending.slice(0, 5).map(r => ({ code: r.code, name: r.name, changePercent: r.changePercent })) };
}
export function marketContext(dataset: MarketDataset) {
  return `【本轮平台实际取得的结构化行情：${dataset.id}】\n有效记录 ${dataset.rows.length} / 请求 ${dataset.requested} 条；数据日期 ${dataset.dataDate}；获取时间 ${dataset.retrievedAt}。\n样本口径：${dataset.selection}。价格为人民币元，涨跌幅为百分数，成交量单位为手（100 股）。这是腾讯财经最新返回的第三方行情快照，不是交易所认证逐笔数据；获取日期不等于交易日期。${dataset.stale ? '数据超过 7 个自然日，不能当作当前行情。' : ''}\n缺失代码：${dataset.missing.join(',') || '无'}\n平台按原始行计算的统计：${JSON.stringify(marketSummary(dataset))}\n以下 CSV 是本轮实际数值，不是样本代码池或待运行脚本；完整保留前导零。\n${marketCsv(dataset)}\n【本轮行情结束】\n使用这份本轮数据交接；旧聊天、旧摘要中「无数据」「0 条」的判断不能覆盖这份新快照。不要要求用户重新传递平台已提供的行。无法确认的其他字段保持未知。`;
}
