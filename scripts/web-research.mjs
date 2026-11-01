import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Worker } from 'node:worker_threads';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { DOMParser } from 'linkedom';
import { z } from 'zod';
import { readMarketQuotes } from './market-data.mjs';

export const researchSchema = z.object({ queries: z.array(z.string().trim().min(2).max(180)).max(3).default([]), urls: z.array(z.string().max(2048)).max(3).default([]), market: z.object({ count: z.number().int().min(1).max(100), symbols: z.array(z.string().regex(/^(?:sh|sz)?(?:60|68|00|30)\d{4}$/i)).max(100).optional() }).optional() }).refine(v => v.queries.length + v.urls.length > 0 || v.market);
export async function resolvePublicHost(host, { lookupFn = lookup, dohFetch = fetch } = {}) {
  const addresses = await lookupFn(host, { all: true });
  const fakeV4 = ip => /^198\.(?:18|19)\./.test(ip);
  const fakeV6 = ip => /^::ffff:0:c6(?:12|13):/i.test(ip);
  // TUN proxies may return synthetic benchmarking addresses. Verify the public
  // destination independently, then pin those public IPs; never allow the synthetic range.
  if (!addresses.some(a => fakeV4(a.address)) || !addresses.every(a => fakeV4(a.address) || fakeV6(a.address))) return addresses;
  const response = await dohFetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, { signal: AbortSignal.timeout(10000), credentials: 'omit', redirect: 'error', headers: { Accept: 'application/dns-json' } });
  if (!response.ok) throw new Error('代理环境下无法验证公网域名，请检查网络后重试。');
  const result = await response.json();
  return (result.Answer || []).filter(item => item.type === 1 && isPublicAddress(item.data)).map(item => ({ address: item.data, family: 4 }));
}
export function isPublicAddress(ip) {
  ip = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19));
  }
  if (isIP(ip) === 6) return /^2[0-9a-f]{3}:/.test(ip) && !/^2001:(?:db8|0|2|10|20):|^2002:/i.test(ip);
  return false;
}
export async function validatePublicUrl(value, resolver = lookup, addressesOut) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port)) throw new Error('只支持公开网页的 HTTP/HTTPS 地址。');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host.includes('.') && !isIP(host) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) || /(?:token|api[_-]?key|secret|password|signature|authorization)=/i.test(url.search)) throw new Error('不能读取本机、私有网络或带敏感凭据的网址。');
  const addresses = isIP(host) ? [{ address: host }] : await resolver(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('该网址没有可访问的公网地址。');
  addressesOut?.push(...addresses);
  url.hash = ''; return url;
}
export function publicFetch(url, options) {
  // Pin the validated DNS answer for this connection, including every redirect.
  // The research client has no cookie jar, account tokens, file access or API credentials.
  return new Promise((resolve, reject) => {
    const addresses = options.addresses;
    const req = (url.startsWith('https:') ? httpsRequest : httpRequest)(url, { method: 'GET', headers: options.headers, signal: options.signal, lookup: (_host, settings, callback) => {
      const usable = addresses.map(a => ({ address: a.address, family: a.family || isIP(a.address) }));
      settings.all ? callback(null, usable) : callback(null, usable[0].address, usable[0].family);
    } }, res => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      resolve(new Response([204, 205, 304].includes(res.statusCode) ? null : Readable.toWeb(res), { status: res.statusCode, headers }));
    });
    req.once('error', reject); req.end();
  });
}
const tidy = text => String(text || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
function documentOf(text, xml = false) { return new DOMParser().parseFromString(text, xml ? 'text/xml' : 'text/html'); }
export function parseSearchResults(text, engine) {
  const doc = documentOf(text, engine === 'bing');
  if (engine === 'bing') return [...doc.querySelectorAll('item')].map(item => ({ title: tidy(item.querySelector('title')?.textContent), url: tidy(item.querySelector('link')?.textContent), text: tidy(item.querySelector('description')?.textContent).replace(/<[^>]*>/g, '') }));
  return [...doc.querySelectorAll('.result')].map(item => {
    const a = item.querySelector('.result__a'), raw = a?.getAttribute('href') || '';
    let url = raw;
    try { const target = new URL(raw, 'https://html.duckduckgo.com'); url = target.searchParams.get('uddg') || target.href; } catch {}
    return { title: tidy(a?.textContent), url, text: tidy(item.querySelector('.result__snippet')?.textContent) };
  }).filter(item => item.title && /^https?:/.test(item.url));
}
export function relevantSearchResult(result, query) {
  const content = `${result.title} ${result.text} ${result.url}`.toLowerCase();
  const generic = new Set(['the', 'and', 'for', 'with', 'latest', 'current', 'today', 'official', 'report', '2026']);
  const tokens = (query.toLowerCase().match(/[a-z]{3,}|[\u4e00-\u9fff]+/g) || []).filter(t => !generic.has(t));
  const matches = tokens.filter(token => /^[\u4e00-\u9fff]+$/.test(token) ? Array.from({length:Math.max(0,token.length-1)},(_,i)=>token.slice(i,i+2)).some(part=>content.includes(part)) : content.includes(token));
  if (!matches.length) return false;
  if (/股价|股票|行情|沪深|财报|财务|证券|earnings|stock|financial/i.test(query) && !/股价|股票|行情|证券|交易所|业绩|财务|财报|投资者|stock|shares|earnings|financial|investor|exchange|tencent|finance|szse|sse\.com/i.test(content)) return false;
  return true;
}
export function parseWebPage(text, url) {
  const doc = documentOf(text);
  const title = tidy(doc.querySelector('title')?.textContent || new URL(url).hostname);
  const publishedAt = doc.querySelector('meta[property="article:published_time"],meta[name="date"],meta[name="pubdate"],meta[name="publishdate"]')?.getAttribute('content')?.slice(0, 100);
  const links = [...doc.querySelectorAll('a[href]')].map(a => {
    try { return { title: tidy(a.textContent).slice(0, 160), url: new URL(a.getAttribute('href'), url).href }; } catch { return null; }
  }).filter(Boolean).filter(a => {
    if (!/^https?:/.test(a.url) || /web\.archive\.org|wikipedia\.org/.test(new URL(a.url).hostname)) return false;
    const report = /业绩|财报|财务报告|季报|年报|earnings|results|annual|interim|financial report/i.test(a.title);
    const index = /投资者|investors|investor relations/i.test(a.title);
    const sourceHost = new URL(url).hostname.replace(/^www\./, ''), targetHost = new URL(a.url).hostname.replace(/^www\./, '');
    const sameSite = sourceHost === targetHost || targetHost.endsWith('.' + sourceHost);
    return (report || index) && sameSite;
  }).map(a => ({ ...a, pdf: /\.pdf(?:$|\?)/i.test(a.url) })).slice(0, 24);
  for (const e of doc.querySelectorAll('script,style,noscript,svg,nav,footer,header,form,iframe,template')) e.remove();
  for (const e of doc.querySelectorAll('td,th')) e.appendChild(doc.createTextNode(' | '));
  for (const e of doc.querySelectorAll('p,div,section,article,main,tr,li,h1,h2,h3,h4,br')) e.appendChild(doc.createTextNode('\n'));
  const body = doc.querySelector('article,main,[role="main"]') || doc.body || doc;
  return { title, publishedAt, text: tidy(body.textContent), links };
}
function relevantExcerpt(text, queries, limit = 6500) {
  if (text.length <= limit) return text;
  const tokens = [...new Set(queries.join(' ').toLowerCase().match(/[a-z]{3,}|[\u4e00-\u9fff]{2,4}|20\d\d/g) || [])];
  // Keep PDF pages together so a numeric table retains its period, currency and units.
  const blocks = text.includes('[PDF 第') ? text.split(/(?=\[PDF 第 \d+ 页\])/).filter(Boolean) : text.match(/[\s\S]{1,1500}/g) || [];
  const ranked = blocks.map((block, index) => ({ block, index, score: tokens.reduce((n, token) => n + (block.toLowerCase().includes(token) ? 1 : 0), 0) + (block.match(/(?:revenue|profit|cash flow|收入|营收|净利|现金流)[\s\S]{0,100}?\d/gi) || []).length * 3 + (/financial highlights|consolidated income statement|consolidated statement of cash|财务摘要|合并利润表|现金流量表/i.test(block) ? 12 : 0) }));
  const selected = [ranked[0]]; let length = ranked[0].block.length;
  for (const entry of ranked.slice(1).sort((a, b) => b.score - a.score)) {
    if (length + entry.block.length > limit) continue;
    selected.push(entry); length += entry.block.length;
  }
  return selected.sort((a, b) => a.index - b.index).map(s => s.block).join('\n[…节选…]\n').slice(0, limit);
}
export function extractPdf(bytes, signal, workerPath = new URL('./pdf-text-worker.mjs', import.meta.url)) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 192 }, execArgv: [] });
    let settled = false;
    const done = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); void worker.terminate(); error ? reject(error) : resolve(value); };
    const abort = () => done(signal.reason || new Error('已停止读取 PDF。'));
    const timer = setTimeout(() => done(new Error('PDF 读取超时。')), 20000);
    worker.once('message', value => done(value.error ? new Error(value.error) : null, value));
    worker.once('error', () => done(new Error('PDF 文本读取失败。')));
    worker.once('exit', code => { if (code !== 0) done(new Error('PDF 读取已结束。')); });
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}
export function createWebResearch({ fetcher = publicFetch, resolver = resolvePublicHost, pdf = extractPdf } = {}) {
  async function readUrl(value, signal, limit = 8_000_000) {
    let url = value;
    for (let redirect = 0; redirect < 4; redirect++) {
      signal.throwIfAborted();
      const addresses = [], safe = await validatePublicUrl(url, resolver, addresses);
      signal.throwIfAborted();
      const response = await fetcher(safe.href, { addresses, redirect: 'manual', credentials: 'omit', signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; poie/0.8; public research)', Accept: 'text/html,application/xhtml+xml,application/xml,application/pdf,text/plain;q=0.9,*/*;q=0.5', 'Accept-Encoding': 'identity' } });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); const to = response.headers.get('location'); if (!to) throw new Error('网页重定向缺少地址。'); url = new URL(to, safe).href; continue; }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`网站返回 ${response.status}，未能读取正文。`); }
      if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('文档超过 8 MB 读取上限。'); }
      const reader = response.body?.getReader(); if (!reader) throw new Error('网页没有返回内容。');
      const chunks = []; let size = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; signal.throwIfAborted(); size += value.length; if (size > limit) throw new Error('网页或文档过大。'); chunks.push(value); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
      return { bytes, url: safe.href, type: response.headers.get('content-type') || '' };
    }
    throw new Error('网页重定向次数过多。');
  }
  function decode(bytes, type) { try { return new TextDecoder(type.match(/charset=([\w-]+)/i)?.[1] || 'utf-8').decode(bytes); } catch { return new TextDecoder().decode(bytes); } }
  async function search(query, signal) {
    if (/sk-[A-Za-z0-9_-]{12,}|bearer\s|password\s*[:=]|api[_ -]?key\s*[:=]/i.test(query)) throw new Error('检索词含疑似密钥，已停止联网。');
    for (const engine of ['ddg', 'bing']) {
      try {
        const url = engine === 'ddg' ? `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}` : `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
        const page = await readUrl(url, AbortSignal.any([signal, AbortSignal.timeout(15000)]), 1_000_000);
        const results = parseSearchResults(decode(page.bytes, page.type), engine).filter(result => relevantSearchResult(result, query));
        if (results.length) return results.slice(0, 5);
      } catch (e) { if (signal.aborted) throw e; }
    }
    throw new Error('公开搜索暂时不可用或没有结果，可提供公司公告/报告的公开链接。');
  }
  return async function research(input, signal, progress = () => {}) {
    const { queries, urls, market } = researchSchema.parse(input), checkedAt = new Date().toISOString();
    if (market) {
      const result = await readMarketQuotes(market, signal, readUrl, checkedAt, progress);
      return { queries: [], checkedAt, sources: result.sources, warnings: result.warnings, datasets: [result.dataset] };
    }
    const sources = [], warnings = [], candidates = urls.map(url => ({ url, title: '用户提供的公开资料', text: '' }));
    const seen = new Set();
    if (queries.length) progress('正在搜索公开资料…');
    const searches = await Promise.all(queries.map(async query => {
      signal.throwIfAborted();
      try { return await search(query, signal); }
      catch (e) { if (signal.aborted) throw e; warnings.push(e.message); return []; }
    }));
    // Interleave results so the first query cannot crowd out other aspects of the task.
    for (let n = 0; n < 5; n++) for (const results of searches) if (results[n]) candidates.push(results[n]);
    const score = c => (/investor|earnings|financial|results|业绩|财报|报告/i.test(c.title + ' ' + c.url) ? 3 : 0) - (/wikipedia|web\.archive/.test(c.url) ? 4 : 0);
    const unique = candidates.filter(c => { if (seen.has(c.url)) return false; seen.add(c.url); return true; }).sort((a, b) => score(b) - score(a)).slice(0, 6);
    const linked = [];
    let completed = 0;
    async function readCandidate(c, index) {
      signal.throwIfAborted();
      progress(`正在读取公开资料 · 已完成 ${completed} 份…`);
      const source = { id: `S${index + 1}`, title: c.title, url: c.url, text: c.text.slice(0, 1200), status: c.text ? 'snippet' : 'unavailable', retrievedAt: new Date().toISOString() };
      try {
        const page = await readUrl(c.url, AbortSignal.any([signal, AbortSignal.timeout(20000)]));
        source.url = page.url;
        if (page.type.includes('application/pdf') || new TextDecoder().decode(page.bytes.slice(0, 5)) === '%PDF-') {
          const doc = await pdf(page.bytes, signal); source.text = relevantExcerpt(doc.text, queries, 10000); source.pages = doc.pages;
          if (source.text.trim().length < 40) throw new Error('PDF 没有足够的可提取文字；扫描件暂不支持。');
        } else if (/text\/html|application\/xhtml|text\/plain|xml/.test(page.type)) {
          const doc = parseWebPage(decode(page.bytes, page.type), page.url);
          if (doc.text.length < 120 || /^(?:Just a moment|Access Denied|Attention Required|Wayback Machine)/i.test(doc.title) || /captcha|验证你是人类|人机验证/i.test(doc.title)) throw new Error('网站需要登录、验证或浏览器加载，未能读取正文。');
          source.title = doc.title; source.text = relevantExcerpt(doc.text, queries); source.publishedAt = doc.publishedAt;
          linked.push(...doc.links.filter(link => !seen.has(link.url)));
        } else throw new Error('该链接不是可读取的网页或 PDF。');
        source.status = 'read';
      } catch (e) { if (signal.aborted) throw e; source.error = e.message; }
      sources[index] = source; completed++;
    }
    for (let offset = 0; offset < unique.length; offset += 3) await Promise.all(unique.slice(offset, offset + 3).map((c, n) => readCandidate(c, offset + n)));
    // Search engines can return a company's homepage. Follow observed investor / results
    // links on that same public site, at most two hops, before reading the linked reports.
    for (let hop = 0; hop < 2; hop++) {
      const index = linked.filter(c => !c.pdf && !seen.has(c.url)).sort((a, b) => score(b) - score(a))[0];
      if (!index) break; seen.add(index.url); await readCandidate({ ...index, text: '' }, sources.length);
    }
    // Follow at most two report PDFs actually linked by a fetched page, never invented links.
    const reports = linked.filter(c => { if (!c.pdf || seen.has(c.url)) return false; seen.add(c.url); return true; }).slice(0, 2), offset = sources.length;
    await Promise.all(reports.map((c, index) => readCandidate({ ...c, text: '' }, offset + index)));
    signal.throwIfAborted();
    if (!sources.some(s => s.status === 'read')) warnings.push('本次没有成功取得正文资料，不能据此宣称已核验最新财务数据。');
    progress(`检索完成 · ${sources.filter(s => s.status === 'read').length} 份正文资料`);
    return { queries, checkedAt, sources, warnings: [...new Set(warnings)] };
  };
}
