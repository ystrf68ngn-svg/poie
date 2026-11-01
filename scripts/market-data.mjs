import { createHash } from 'node:crypto';
export const DEFAULT_A_SHARE_SAMPLE = (`600519 601318 600036 601398 601288 601988 601939 600030 601628 600028 601857 600900 601088 600104 601633 600276 600887 603288 600809 601899 600585 601668 601601 600438 600690 601012 600031 601166 600000 601818 600048 601390 600050 600406 601688 600352 600196 601600 600999 601111
000001 000002 000063 000100 000333 000651 000858 000568 000725 000776 000895 002415 002594 002714 002304 002475 002352 002142 002027 000166 000538 002050 000876 002241 000625
300750 300059 300760 300124 300015 300122 300274 300450 300142 300347 300498 300033 300408 300782 300308 300502 300661 300253 300454 300496
688981 688111 688036 688012 688008 688180 688169 688223 688363 688599 688303 688396 688520 688187 688777`).trim().split(/\s+/);
export function quoteSymbol(value) {
  const code = value.toLowerCase().replace(/^(sh|sz)/, '');
  if (!/^(?:60|68|00|30)\d{4}$/.test(code)) throw new Error('只支持沪深 A 股六位代码。');
  const symbol = (/^6/.test(code) ? 'sh' : 'sz') + code;
  if (/^(sh|sz)/i.test(value) && symbol !== value.toLowerCase()) throw new Error('股票代码与交易所不匹配。');
  return symbol;
}
export function parseTencentQuotes(text, requested, retrievedAt) {
  const rows = [], seen = new Set();
  for (const match of text.matchAll(/v_((?:sh|sz)\d{6})="([^"\r\n]*)";/g)) {
    const symbol = match[1], fields = match[2].split('~');
    if (!requested.includes(symbol) || seen.has(symbol) || fields[2] !== symbol.slice(2) || fields.length < 35) continue;
    const number = index => fields[index]?.trim() ? Number(fields[index]) : NaN;
    const [price, previousClose, open, high, low, changePercent, rawVolume] = [3, 4, 5, 33, 34, 32, 6].map(number);
    const stamp = fields[30];
    if (![price, previousClose, open, high, low, changePercent, rawVolume].every(Number.isFinite) || price <= 0 || previousClose <= 0 || high < low || high < price || low > price || rawVolume < 0 || !/^20\d{12}$/.test(stamp)) continue;
    const trade = fields[35]?.split('/'), amountCny = Number(trade?.[2]);
    if (!trade || trade.length !== 3 || !Number.isFinite(amountCny) || amountCny < 0) continue;
    // The same public feed returns some boards in shares and others in lots.
    // Accept a unit only when turnover / shares fits the actual day's price range;
    // never mix raw values into a supposedly uniform volume chart.
    const candidates = rawVolume > 0 && amountCny > 0 ? [1, 100].filter(factor => { const average = amountCny / (rawVolume * factor); return average >= low * 0.995 && average <= high * 1.005; }) : rawVolume === 0 && amountCny === 0 ? [100] : [];
    if (candidates.length !== 1) continue;
    const rawVolumeUnit = candidates[0] === 1 ? 'shares' : 'lots';
    const volumeLots = rawVolume * candidates[0] / 100;
    const quoteTime = `${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}T${stamp.slice(8,10)}:${stamp.slice(10,12)}:${stamp.slice(12,14)}+08:00`;
    if (!Number.isFinite(Date.parse(quoteTime)) || new Date(Date.parse(quoteTime) + 8 * 3600000).toISOString().slice(0,19) !== quoteTime.slice(0,19) || Date.parse(quoteTime) > Date.parse(retrievedAt) + 120000) continue;
    const calculated = (price / previousClose - 1) * 100;
    if (Math.abs(calculated - changePercent) > 0.15) continue;
    seen.add(symbol);
    rows.push({ code: fields[2], name: fields[1].replace(/[\r\n\u0000]/g, '').slice(0, 30), exchange: symbol.startsWith('sh') ? 'SH' : 'SZ', price, previousClose, open, high, low, changePercent, volumeLots, amountCny, rawVolumeUnit, quoteTime, source: `https://qt.gtimg.cn/q=${symbol}` });
  }
  return rows;
}
export async function readMarketQuotes(input, signal, readUrl, retrievedAt, progress) {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 100) throw new Error('当前单批行情支持 1–100 只股票，请拆分更大的任务。');
  const symbols = [...new Set((input.symbols?.length ? input.symbols : DEFAULT_A_SHARE_SAMPLE.slice(0, input.count)).map(quoteSymbol))];
  if (symbols.length !== input.count) throw new Error('股票数量与代码清单不一致，请确认样本。');
  const rows = [], sources = [], warnings = [];
  for (let offset = 0; offset < symbols.length; offset += 40) {
    signal.throwIfAborted(); progress(`正在读取真实行情 · ${offset} / ${symbols.length} 只…`);
    const chunk = symbols.slice(offset, offset + 40), url = `https://qt.gtimg.cn/q=${chunk.join(',')}`;
    try {
      const page = await readUrl(url, AbortSignal.any([signal, AbortSignal.timeout(15000)]), 1000000);
      const parsed = parseTencentQuotes(new TextDecoder('gb18030').decode(page.bytes), chunk, retrievedAt);
      rows.push(...parsed);
      sources.push({ id: `M${sources.length + 1}`, title: `腾讯财经公开行情（${parsed.length}/${chunk.length} 只）`, url, status: parsed.length ? 'read' : 'unavailable', retrievedAt, text: `实际解析 ${parsed.length} 条有价格和时间戳的记录。详见本轮结构化 CSV。`, ...(!parsed.length ? { error: '接口没有返回有效行情行。' } : {}) });
    } catch (e) { if (signal.aborted) throw e; warnings.push(`行情读取失败：${e.message}`); }
  }
  signal.throwIfAborted();
  const dataDate = rows.map(r => r.quoteTime.slice(0, 10)).sort().at(-1) || '';
  const currentRows = rows.filter(r => r.quoteTime.startsWith(dataDate));
  const missing = symbols.filter(s => !currentRows.some(r => r.code === s.slice(2)));
  const stale = !dataDate || Date.parse(retrievedAt) - Date.parse(dataDate + 'T00:00:00+08:00') > 7 * 86400000;
  if (missing.length) warnings.push(`${missing.length} 只股票没有同日有效行情，不能声称已完成 ${input.count} 条采集。`);
  if (stale) warnings.push('行情日期过旧或没有有效日期，不能作为最新行情。');
  const dataset = { id: 'market-' + createHash('sha256').update(JSON.stringify(currentRows)).digest('hex').slice(0, 16), kind: 'cn-a-quotes', requested: input.count, selection: input.symbols?.length ? '用户指定代码；不代表全市场' : '默认沪深分层样本（沪市主板40、深市主板25、创业板20、科创板15），按清单取前 N 只；不是全市场或排名样本', retrievedAt, dataDate, rows: currentRows, missing, stale };
  progress(`行情读取完成 · ${currentRows.length} / ${input.count} 条有效记录`);
  return { dataset, sources, warnings };
}
