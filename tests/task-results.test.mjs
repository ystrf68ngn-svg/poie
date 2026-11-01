import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTask, readTaskResponse, taskBrief, reportDocument } from '../lib/task-results.ts';
import { initialWorkspace, restoreWorkspace, message } from '../lib/workspace.ts';
import { runTeamTasks, teamHandoff } from '../lib/team-work.ts';

const task = { id:'collect', title:'采集每日股价数据', description:'获取100条真实行情并传递给制图成员', agentId:'deepseek', status:'pending' };
const complete = { state:'complete', summary:'已采集', missing:[] };
const dataset = { id:'market-current', kind:'cn-a-quotes', requested:100, rows:Array.from({length:100},(_,i)=>({code:String(i).padStart(6,'0')})), missing:[], stale:false, dataDate:'2026-10-30' };
test('the reported incident is blocked, even when the UI or model claims completion', () => {
  const actual = '## 结论：本次采集未取得任何行情数据，任务受阻，没有向 GPT 交付任何数值\n数据条数 = 0。下面是100只候选股票及未运行的脚本。';
  const result = assessTask(task,actual,complete);
  assert.equal(result.state,'blocked'); assert.match(taskBrief(task.title,result),/^受阻/);
  assert.equal(assessTask(task,'已完成，下面是100只股票代码和未运行的脚本。',complete).state,'blocked');
});
test('a real current dataset passes collection while incomplete and stale snapshots do not', () => {
  const result=assessTask(task,'本轮已取得100条带价格与时间戳的实际记录。',complete,[dataset]);
  assert.equal(result.state,'done');assert.equal(result.records,100);assert.equal(result.datasetId,'market-current');
  assert.equal(assessTask(task,'已取得99条记录。',complete,[{...dataset,rows:dataset.rows.slice(0,99)}]).state,'blocked');
  assert.equal(assessTask(task,'已取得100条记录。',complete,[{...dataset,stale:true}]).state,'blocked');
});
test('a response alone is unconfirmed; charts and PDF need concrete artifacts', () => {
  assert.equal(assessTask({title:'总结',description:''},'这是已经返回的总结内容，但没有结构化交付回执。').state,'review');
  assert.equal(assessTask({title:'制作图表',description:''},'图表已经做完，请运行我的脚本。',complete).state,'blocked');
  assert.equal(assessTask({title:'交付PDF',description:''},'下面是可打印的HTML报告，已交付PDF。',complete).state,'blocked');
  assert.equal(assessTask({title:'交付PDF',description:''},'这是一份包含实际统计和完整来源的报告。',complete,[],[{id:'pdf',mime:'application/pdf',size:1000,filename:'report.pdf'}]).state,'done');
});
test('machine receipts are stripped from display and cannot turn a blocked response into success', () => {
  const result=readTaskResponse('本轮受阻。\n```poie-status\n{"state":"blocked","summary":"缺数据","missing":["原始行情"]}\n```');
  assert.equal(result.text,'本轮受阻。');assert.equal(result.receipt.state,'blocked');
  assert.equal(readTaskResponse('内容\n```poie-status\nnot json\n```').receipt,undefined);
});
test('a blocked upstream prevents downstream model calls and carries the reason to the summary', async () => {
  let calls=0;
  const deliveries=await runTeamTasks([task,{...task,id:'chart',title:'制图'},{...task,id:'report',title:'报告'}],new AbortController().signal,async t=>{calls++;return{task:t,answer:'没有实际行情数据，任务受阻。',assessment:{state:'blocked',reason:'原始行情缺失'}};});
  assert.equal(calls,1);assert.equal(deliveries.length,3);assert.ok(deliveries.slice(1).every(d=>d.skipped));assert.match(teamHandoff(deliveries),/原始行情缺失/);
});
test('old false completion is reclassified on reopen without removing the original content', () => {
  const w=initialWorkspace(),g=w.groups[0];const original='结论：本次采集未取得任何行情数据，任务受阻。';
  g.plans=[{id:'p',title:'每日股价报告',summary:'',status:'done',mode:'live',tasks:[{...task,status:'done',result:original}]}];
  g.messages=[message('deepseek',original,{presentation:'task',brief:`已完成：${task.title}。详细交付已保存。`})];
  const restored=restoreWorkspace(JSON.stringify(w)).groups[0];
  assert.equal(restored.plans[0].tasks[0].status,'blocked');assert.equal(restored.plans[0].status,'failed');assert.match(restored.messages[0].brief,/^受阻/);assert.equal(restored.messages[0].text,original);
});
test('report rendering escapes plain text and includes actual upstream SVG charts', () => {
  const html=reportDocument('报告','收入 < 5；不能执行 <script>evil()</script>',['```svg\n<svg><rect width="10" height="10"/></svg>\n```']);
  assert.match(html,/&lt;script&gt;/);assert.match(html,/<svg><rect/);
  const withHtml=reportDocument('报告','```html\n<html><body><h1>完整报告</h1></body></html>\n```',['```svg\n<svg><rect width="10" height="10"/></svg>\n```']);assert.match(withHtml,/<section/);assert.match(withHtml,/<svg style=/);
});
