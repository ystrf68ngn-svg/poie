import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_A_SHARE_SAMPLE, parseTencentQuotes, quoteSymbol, readMarketQuotes } from '../scripts/market-data.mjs';
import { marketRequest, marketCsv, marketContext, marketSummary } from '../lib/market-data.ts';
import { relevantSearchResult, createWebResearch } from '../scripts/web-research.mjs';
import { marketChart } from '../lib/market-chart.ts';
import { savedResearch } from '../lib/research.ts';

const now='2026-10-31T15:00:00.000Z';
function quote(symbol, overrides={}) {const f=Array(50).fill('');Object.assign(f,{1:'样本股票',2:symbol.slice(2),3:'11',4:'10',5:'10.5',6:'1000',30:'20261030150000',32:'10',33:'11.2',34:'10.2',35:'11/1000/1070000',...overrides});return`v_${symbol}="${f.join('~')}";`;}
test('quote routing recognizes this workflow, keeps six-digit codes and avoids US-market substitution',()=>{
  assert.deepEqual(marketRequest('每日股价报告','中国股市收集100条数据'),{count:100});
  assert.deepEqual(marketRequest('读取000001和600519股价'),{count:2,symbols:['000001','600519']});
  assert.equal(marketRequest('分析美股AAPL股价'),undefined);assert.equal(marketRequest('查询腾讯最新财报'),undefined);
  assert.equal(DEFAULT_A_SHARE_SAMPLE.length,100);assert.equal(new Set(DEFAULT_A_SHARE_SAMPLE).size,100);
  assert.throws(()=>quoteSymbol('sh000001'));assert.throws(()=>quoteSymbol('../secret'));
});
test('quote parser rejects malformed, missing, duplicate, future and inconsistent prices',()=>{
  const text=quote('sz000001')+quote('sz000001')+quote('sh600519',{3:'NaN'})+quote('sh600036',{30:'20991030150000'})+quote('sh600000',{32:'55'});
  const rows=parseTencentQuotes(text,['sz000001','sh600519','sh600036','sh600000'],now);
  assert.equal(rows.length,1);assert.equal(rows[0].code,'000001');assert.equal(rows[0].price,11);assert.equal(rows[0].quoteTime,'2026-10-30T15:00:00+08:00');
});
test('board-specific raw volume units are normalized only when turnover validates them',()=>{
  const rows=parseTencentQuotes(quote('sz000001')+quote('sh688223',{6:'100000',35:'11/100000/1070000'}),['sz000001','sh688223'],now);
  assert.equal(rows.length,2);assert.ok(rows.every(r=>r.volumeLots===1000));assert.equal(rows[0].rawVolumeUnit,'lots');assert.equal(rows[1].rawVolumeUnit,'shares');
  assert.equal(parseTencentQuotes(quote('sz000001',{35:'11/1000/3'}),['sz000001'],now).length,0);
});
test('100 actual records are collected, exported and passed in full instead of a clipped search excerpt',async()=>{
  const calls=[];
  const result=await readMarketQuotes({count:100},new AbortController().signal,async url=>{calls.push(url);const symbols=url.split('q=')[1].split(',');return{bytes:new TextEncoder().encode(symbols.map(s=>quote(s,{1:'sample'})).join('\n'))};},now,()=>{});
  assert.equal(calls.length,3);assert.equal(result.dataset.rows.length,100);assert.equal(result.dataset.missing.length,0);assert.equal(result.dataset.dataDate,'2026-10-30');
  const csv=marketCsv(result.dataset);assert.equal(csv.split('\n').length,101);assert.ok(csv.includes('"000001"'));const context=marketContext(result.dataset);assert.ok(context.includes(result.dataset.rows.at(-1).code));assert.match(context,/有效记录 100/);assert.equal(marketSummary(result.dataset).rising,100);
  const chart=marketChart(result.dataset);assert.equal([...chart.matchAll(/data-code="\d{6}"/g)].length,100);assert.ok(!/NaN|Infinity/.test(chart));assert.ok(chart.includes(result.dataset.rows.at(-1).code));
  const restored=savedResearch(JSON.parse(JSON.stringify([{datasets:[result.dataset]}])),'沿用刚才的100条数据重新做图，不要重新联网');assert.equal(restored.datasets[0].rows.length,100);assert.ok(marketContext(restored.datasets[0]).includes(result.dataset.rows.at(-1).code));
  assert.equal(savedResearch([{datasets:[result.dataset]}],'你好'),undefined);assert.equal(savedResearch([{datasets:[result.dataset]}],'重新采集今天的行情'),undefined);
});
test('partial and mixed-date batches preserve gaps and cancellation starts no later requests',async()=>{
  const partial=await readMarketQuotes({count:2,symbols:['000001','600519']},new AbortController().signal,async()=>({bytes:new TextEncoder().encode(quote('sz000001')+quote('sh600519',{30:'20261029150000'}))}),now,()=>{});
  assert.equal(partial.dataset.rows.length,1);assert.deepEqual(partial.dataset.missing,['sh600519']);
  const c=new AbortController();let calls=0;
  await assert.rejects(readMarketQuotes({count:100},c.signal,async()=>{calls++;c.abort();return{bytes:new Uint8Array()};},now,()=>{}));assert.equal(calls,1);
});
test('irrelevant law and calendar pages are rejected for a financial search',()=>{
  assert.equal(relevantSearchResult({title:'Facts and Case Summary - Miranda v. Arizona',text:'Supreme Court',url:'https://uscourts.gov/miranda'},'中国股市最新行情 2026'),false);
  assert.equal(relevantSearchResult({title:'Year 2026 Calendar',text:'United States',url:'https://timeanddate.com/2026'},'股票行情 2026'),false);
  assert.ok(relevantSearchResult({title:'Tencent financial results',text:'Latest earnings announcement',url:'https://www.tencent.com/investors'},'Tencent latest quarterly earnings'));
});
test('structured quote research uses the protected fetch path and does not fall back to irrelevant pages',async()=>{
  const result=await createWebResearch({resolver:async()=>[{address:'93.184.216.34',family:4}],fetcher:async(url,options)=>{assert.ok(url.startsWith('https://qt.gtimg.cn/q='));assert.equal(options.credentials,'omit');return new Response(quote('sz000001',{1:'sample',30:new Date().toISOString().replace(/[-:T.Z]/g,'').slice(0,14)}));}})({market:{count:1,symbols:['000001']}},new AbortController().signal);
  assert.equal(result.datasets.length,1);assert.equal(result.datasets[0].rows[0].code,'000001');
});
