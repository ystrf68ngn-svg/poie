import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createLocalServer } from '../scripts/local-server.mjs';
import { createWebResearch, parseSearchResults, parseWebPage, validatePublicUrl, isPublicAddress, extractPdf, resolvePublicHost } from '../scripts/web-research.mjs';
import { needsWebResearch, parseSearchPlan, researchContext, sourceReferences, briefResult, visibleAnswer } from '../lib/research.ts';
import { exportMarkdown } from '../lib/workspace.ts';

const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
const page = (title, text, extra = '') => `<html><head><title>${title}</title><meta property="article:published_time" content="2026-10-20"/></head><body><nav>ignored navigation</nav><main><h1>${title}</h1><p>${text.repeat(4)}</p>${extra}</main></body></html>`;
const html = text => new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const search = (url, title = '官方业绩公告') => `<div class="result"><a class="result__a" href="${url}">${title}</a><div class="result__snippet">这是搜索摘要，不能当作已读取的正文。</div></div>`;

test('research is on demand, greetings stay local, user can disable it', () => {
  for (const text of ['查腾讯最新财报', '请联网核查利润', 'Analyze the latest annual report', '读取 https://example.com/a.pdf']) assert.ok(needsWebResearch(text));
  for (const text of ['你好', 'hello', '设计一个按钮', '不要联网，只分析上传资料', '不用搜索最新新闻']) assert.equal(needsWebResearch(text), false);
  assert.equal(needsWebResearch('查最新财报', 'off'), false); assert.ok(needsWebResearch('比较两个观点', 'on'));
  assert.deepEqual(parseSearchPlan('```json\n{"queries":["腾讯 官方业绩","腾讯 官方业绩"]}\n```'), ['腾讯 官方业绩']);
  assert.throws(() => parseSearchPlan('not json'));
});
test('HTML and search extraction preserve real links, dates and table text without running scripts', () => {
  const parsed = parseWebPage(page('2026 业绩', 'Revenue 100 million. ', '<table><tr><td>利润</td><td>20</td></tr></table><script>globalThis.leaked=true</script><a href="/report.pdf">年度财务报告</a>'), 'https://example.com/ir');
  assert.equal(parsed.title, '2026 业绩'); assert.equal(parsed.publishedAt, '2026-10-20'); assert.match(parsed.text, /利润/);
  assert.ok(!parsed.text.includes('globalThis')); assert.ok(!parsed.text.includes('ignored navigation')); assert.equal(parsed.links[0].url, 'https://example.com/report.pdf');
  const ddg = parseSearchResults(search('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Freport'), 'ddg'); assert.equal(ddg[0].url, 'https://example.com/report');
  const bing = parseSearchResults('<rss><channel><item><title>Report</title><link>https://example.com/report</link><description>Revenue update</description></item></channel></rss>', 'bing'); assert.equal(bing[0].text, 'Revenue update');
});
test('research blocks private, credential-bearing and rebound destinations before fetching', async () => {
  for (const value of ['127.0.0.1','10.1.2.3','169.254.169.254','192.168.1.1','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1','2002:7f00:1::']) assert.equal(isPublicAddress(value), false);
  for (const url of ['file:///etc/passwd','http://127.1','http://2130706433','http://[::1]','http://localhost','http://example.com:4318','https://user:pass@example.com','https://example.com/?api_key=private']) await assert.rejects(validatePublicUrl(url, resolver));
  await assert.rejects(validatePublicUrl('https://example.com', async () => [{address:'93.184.216.34'},{address:'10.0.0.1'}]));
  let count = 0;
  const research = createWebResearch({ resolver, fetcher: async (_url, options) => { count++; assert.equal(options.credentials, 'omit'); assert.equal(options.headers.Authorization, undefined); assert.equal(options.addresses[0].address, '93.184.216.34'); return new Response(null, { status:302,headers:{location:'http://127.0.0.1/private'} }); } });
  const result = await research({ urls:['https://example.com'] }, new AbortController().signal); assert.equal(count,1); assert.equal(result.sources[0].status,'unavailable');
});
test('proxy synthetic DNS is independently resolved without allowing private ranges', async () => {
  const addresses = await resolvePublicHost('example.com', { lookupFn: async () => [{address:'198.18.0.8'},{address:'::ffff:0:c612:8'}], dohFetch: async (url, options) => { assert.ok(url.startsWith('https://cloudflare-dns.com/dns-query?')); assert.equal(options.credentials,'omit'); return Response.json({Answer:[{type:1,data:'93.184.216.34'},{type:1,data:'10.0.0.1'}]}); } });
  assert.deepEqual(addresses,[{address:'93.184.216.34',family:4}]);
  const privateAddress = await resolvePublicHost('example.com', {lookupFn:async()=>[{address:'10.0.0.1'}],dohFetch:()=>{throw new Error('must not override private DNS');}});
  await assert.rejects(validatePublicUrl('https://example.com',async()=>privateAddress));
});
test('real research pipeline falls back from unavailable search, reads pages and follows only linked report PDFs', async () => {
  const calls=[];
  const research=createWebResearch({resolver, pdf:async()=>({text:'[PDF 第 1 页]\nAnnual revenue 100 million, net profit 20 million. '.repeat(10),pages:3}),fetcher:async(url,options)=>{
    calls.push(url);assert.equal(options.method,undefined);assert.equal(options.headers['x-api-key'],undefined);
    if(url.includes('duckduckgo.com'))return html('<html>captcha</html>');
    if(url.includes('bing.com'))return new Response('<rss><channel><item><title>Official report</title><link>https://example.com/ir</link><description>Annual results</description></item></channel></rss>',{headers:{'content-type':'text/xml'}});
    if(url.endsWith('/ir'))return html(page('Official results','Financial results announced. ','<a href="/annual.pdf">Annual report</a>'));
    if(url.endsWith('/annual.pdf'))return new Response('%PDF-fixture',{headers:{'content-type':'application/pdf'}});
    throw new Error('unexpected URL');
  }});
  const statuses=[],result=await research({queries:['Company annual report']},new AbortController().signal,p=>statuses.push(p));
  assert.equal(result.sources.length,2);assert.ok(result.sources.every(s=>s.status==='read'));assert.equal(result.sources[1].pages,3);
  assert.equal(calls.length,4);assert.match(statuses.at(-1),/2 份正文/);
  const context=researchContext(result);assert.match(context,/不可信外部数据/);assert.match(context,/获取时间/);assert.match(context,/Annual revenue/);
  assert.ok(sourceReferences(result).every(s=>!('text' in s)));
});
test('failed pages remain labeled snippets, errors never masquerade as successful live research',async()=>{
  const research=createWebResearch({resolver,fetcher:async url=>url.includes('duckduckgo')?html(search('https://example.com/blocked', 'Company latest earnings report')):new Response('',{status:403})});
  const result=await research({queries:['Company latest earnings']},new AbortController().signal);
  assert.equal(result.sources[0].status,'snippet');assert.match(result.sources[0].error,/403/);assert.match(researchContext(result),/只有搜索摘要/);assert.ok(result.warnings.length);
});
test('financial PDF excerpts retain the table period and units with the reported values', async () => {
  const pages = Array.from({ length: 12 }, (_, index) => `[PDF 第 ${index + 1} 页]\n` + (index === 9 ? 'Consolidated income statement. Q2 2026. RMB million.\n' + 'Table row detail. '.repeat(50) + '\nRevenue 204785; profit 56022.\n' : 'Business overview. '.repeat(65)));
  const research = createWebResearch({ resolver, fetcher: async () => new Response('%PDF-test', { headers: { 'content-type': 'application/pdf' } }), pdf: async () => ({ text: pages.join('\n'), pages: 12 }) });
  const result = await research({ urls: ['https://example.com/report.pdf'] }, new AbortController().signal);
  const context = researchContext(result);
  assert.match(context, /Q2 2026\. RMB million/); assert.match(context, /Revenue 204785; profit 56022/);
  const markdown = exportMarkdown({ name: '核查', description: '', plans: [], messages: [{ sender: 'a', text: '完整交付', sources: sourceReferences(result) }] }, [{ id: 'a', name: '成员' }]);
  assert.match(markdown, /https:\/\/example.com\/report.pdf/); assert.match(markdown, /正文节选/);
});
test('stopping research cancels the active fetch and schedules no later documents',async()=>{
  let entered;const started=new Promise(resolve=>entered=resolve),controller=new AbortController();let count=0;
  const research=createWebResearch({resolver,fetcher:async(_url,{signal})=>{count++;entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const pending=research({urls:['https://example.com/a']},controller.signal);await started;controller.abort();await assert.rejects(pending);assert.equal(count,1);
});
test('research bridge streams short progress and cancels when the client disconnects',async t=>{
  let started,aborted;const entered=new Promise(r=>started=r),cancelled=new Promise(r=>aborted=r);
  const {server,stop}=createLocalServer({port:0,research:async(input,signal,progress)=>{assert.deepEqual(input.queries,['public company']);progress('正在搜索公开资料…');started();await new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted();reject(signal.reason);},{once:true}));}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(stop);
  const origin=`http://127.0.0.1:${server.address().port}`,controller=new AbortController();
  const response=await fetch(origin+'/api/research',{method:'POST',headers:{origin,'content-type':'application/json','X-Tongpin-Client':'tongpin'},body:JSON.stringify({queries:['public company']}),signal:controller.signal});
  await entered;const reader=response.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/正在搜索/);controller.abort();await cancelled;
});
test('compact result previews preserve full report separately and do not expose long code blocks',()=>{
  const report='核心结论。\n'+ '详细报告内容。'.repeat(200)+'\n```html\nprivate source\n```';
  const preview=briefResult(report);assert.ok(preview.length<=361);assert.ok(!preview.includes('private source'));assert.match(report,/详细报告/);
});
test('reasoning accidentally embedded by a relay stays out of visible answers',()=>{
  assert.equal(visibleAnswer('<think>internal draft</think>\n结论：收入上升。'),'结论：收入上升。');
  assert.equal(visibleAnswer('<analysis>unfinished reasoning'),'');
  assert.equal(visibleAnswer('```html\n<think>example</think>\n```'),'```html\n<think>example</think>\n```');
});
test('PDF worker extracts text from a real PDF and aborts independently of the app',async()=>{
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const content='BT /F1 12 Tf 20 240 Td (Revenue 100 million. Profit 20 million.) Tj ET';objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  let data='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(data.length);data+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=data.length;data+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const doc=await extractPdf(new TextEncoder().encode(data),new AbortController().signal);assert.equal(doc.pages,1);assert.match(doc.text,/Revenue 100 million/);
  const c=new AbortController();c.abort();assert.throws(()=>extractPdf(new Uint8Array(),c.signal));
});
