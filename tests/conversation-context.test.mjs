import test from 'node:test';
import assert from 'node:assert/strict';
import { initialWorkspace, message, conversationMessages, restoreWorkspace, conversationSystem } from '../lib/workspace.ts';
import { compactConversation, compressionBatch, contextDigest, contextStats, contextRecords, groupContextSystem, recalledHistory, parseContextSummary, CONTEXT_MAX_BATCHES } from '../lib/conversation-context.ts';
const empty = { goal: '交付个人桌面软件', requirements: '', decisions: '', progress: '', pending: '', artifacts: '', questions: '' };
const fixture = (count = 60) => { const w = initialWorkspace(), g = w.groups[0]; g.messages = Array.from({ length: count }, (_, i) => message(i % 2 ? 'deepseek' : 'user', i === 0 ? '硬性要求：离线优先，不允许自动发布，界面颜色为琥珀色。' : `第 ${i} 轮讨论：${'普通进度。'.repeat(10)}`)); return { w, g }; };
async function compact(g, w, overrides = {}) {
  const before = structuredClone(g.messages);
  await compactConversation(g, w.agents, { signal: new AbortController().signal, provider: 'deepseek', model: 'test-model', generate: async (_system, turns) => {
    const input = JSON.parse(turns[0].content);
    return JSON.stringify({ ...empty, ...input.previousSummary, requirements: [input.previousSummary?.requirements, ...input.newRecords.filter(r => r.text.includes('硬性要求')).map(r => r.text)].filter(Boolean).join('\n') });
  }, checkpoint: digest => { g.context = { ...g.context, digest }; }, ...overrides });
  assert.deepEqual(g.messages, before, 'compaction must not alter raw conversation');
}
test('long conversations keep the initial requirements in a persistent summary and send recent messages in full', async () => {
  const { w, g } = fixture(); g.context = { pinned: '任何发布都需要我明确同意。' };
  assert.equal(contextStats(g).needsCompression, true);
  await compact(g, w);
  assert.ok(contextStats(g).covered > 0); assert.equal(contextStats(g).needsCompression, false);
  const turns = conversationMessages(g, 'deepseek', w.agents);
  assert.ok(turns.length <= 24); assert.equal(turns.at(-1).content, g.messages.at(-1).text);
  assert.match(groupContextSystem(g, w.agents, ''), /离线优先.*不允许自动发布/);
  assert.match(groupContextSystem(g, w.agents, ''), /任何发布都需要我明确同意/);
  const reloaded = restoreWorkspace(JSON.stringify(w));
  assert.ok(contextDigest(reloaded.groups[0]));
  assert.deepEqual(reloaded.groups[0].context, g.context);
  assert.match(groupContextSystem(reloaded.groups[0], w.agents, ''), /琥珀色/);
});
test('subsequent compaction merges the prior summary, shares it with a switched model and finds related original evidence', async () => {
  const { w, g } = fixture(); await compact(g, w);
  g.messages.push(...Array.from({ length: 40 }, (_, i) => message(i % 2 ? 'claude' : 'user', `后续讨论 ${i}`)));
  g.messages.push(message('user', '硬性要求：颜色修改为青色，保留其他约束。'));
  g.messages.push(...Array.from({ length: 30 }, (_, i) => message(i % 2 ? 'claude' : 'user', `继续工作 ${i}`)));
  await compact(g, w, { provider: 'custom', model: 'another-vendor-model' });
  assert.match(g.context.digest.summary.requirements, /离线优先/); assert.match(g.context.digest.summary.requirements, /修改为青色/);
  assert.match(groupContextSystem(g, w.agents, '界面颜色为琥珀色'), /原文.*消息/s);
  assert.match(recalledHistory(g, '界面颜色'), /不允许自动发布/);
  assert.equal(conversationMessages(g, 'claude', w.agents)[0].role, 'user');
  assert.equal(g.context.digest.model, 'another-vendor-model');
});
test('long individual records are processed in complete ordered fragments with restartable checkpoints', async () => {
  const { w, g } = fixture(4); g.messages[0].text = '开始要求。' + '原始内容🙂'.repeat(7000) + '最终约束。';
  const source = g.messages[0].text, pieces = [];
  let firstCheckpoint;
  await compact(g, w, { generate: async (_system, turns) => {
    const input = JSON.parse(turns[0].content);
    for (const part of input.newRecords) if (part.id === g.messages[0].id) pieces.push(part.text);
    assert.ok(turns[0].content.length < 60000);
    return JSON.stringify(empty);
  }, checkpoint: digest => { g.context = { ...g.context, digest }; firstCheckpoint ||= structuredClone(digest); } });
  assert.ok(firstCheckpoint.offset > 0); assert.ok(contextDigest(g));
  const suffix = conversationMessages(g, 'deepseek', w.agents)[0].content;
  const coveredText = pieces.join('');
  assert.equal(coveredText, source.slice(0, coveredText.length));
  if (coveredText.length < source.length) assert.ok(suffix.includes(source.slice(coveredText.length)));
  else assert.equal(coveredText, source);
  assert.ok(!/[\uD800-\uDBFF]$/.test(coveredText));
  const resumed = { ...g, context: { digest: firstCheckpoint } };
  const fragment = compressionBatch(resumed, w.agents, true).fragments[0].text;
  assert.equal(fragment, source.slice(firstCheckpoint.offset, firstCheckpoint.offset + fragment.length));
});
test('failures and cancellation preserve the last completed checkpoint and all original records', async () => {
  const { w, g } = fixture(); await compact(g, w);
  g.messages.push(...Array.from({ length: 40 }, (_, i) => message('user', `新增记录 ${i}`)));
  const originalDigest = structuredClone(g.context.digest), originalMessages = structuredClone(g.messages);
  await assert.rejects(compact(g, w, { generate: async () => 'invalid output' }), /摘要/);
  assert.deepEqual(g.context.digest, originalDigest); assert.deepEqual(g.messages, originalMessages);
  const c = new AbortController();
  await assert.rejects(compact(g, w, { signal: c.signal, generate: async () => { c.abort(); return JSON.stringify(empty); } }), /abort/i);
  assert.deepEqual(g.context.digest, originalDigest);
});
test('source edits invalidate stale summaries, groups remain isolated and failed/demo replies are excluded', async () => {
  const { w, g } = fixture();
  g.messages.splice(5, 0, message('deepseek', '未验证草稿', { pending: true }), message('deepseek', '失败回复', { failed: true }), message('user', '演示要求', { demo: true }));
  await compact(g, w);
  assert.equal(contextRecords(g).length, 60);
  const other = { ...g, id: 'other', messages: [message('user', '另一个群')] };
  assert.equal(contextDigest(other), undefined); assert.doesNotMatch(groupContextSystem(other, w.agents, ''), /琥珀色/);
  g.messages[0].text = '变更后的真实需求';
  assert.equal(contextDigest(g), undefined); assert.equal(contextStats(g).needsCompression, true);
});
test('current plan status overrides summaries and the complete plan requirements enter history', async () => {
  const { w, g } = fixture(3);
  g.plans = [{ id: 'plan', title: '桌面交付', summary: '开发应用', status: 'pending', mode: 'live', tasks: [{ id: 't', title: '安装包', description: '必须兼容 Windows 和 Mac，不要求安装 Node.js', agentId: 'deepseek', status: 'pending' }] }];
  g.messages[1] = message('deepseek', '方案准备好了', { planId: 'plan' });
  assert.match(conversationMessages(g, 'deepseek', w.agents)[1].content, /不要求安装 Node/);
  await compact(g, w, { force: true }); const digest = g.context.digest;
  g.plans[0].status = 'approved'; g.plans[0].tasks[0].status = 'running';
  assert.deepEqual(contextDigest(g), digest);
  assert.match(groupContextSystem(g, w.agents, ''), /"status":"approved"/); assert.match(groupContextSystem(g, w.agents, ''), /"status":"running"/);
});
test('backlog processing is bounded, preserves resumable progress and does not fabricate a completed summary', async () => {
  const { w, g } = fixture(4); g.messages[0].text = 'a'.repeat(18000 * (CONTEXT_MAX_BATCHES + 3));
  let calls = 0;
  await assert.rejects(compact(g, w, { generate: async () => { calls++; return JSON.stringify(empty); } }), /继续整理/);
  assert.equal(calls, CONTEXT_MAX_BATCHES); assert.ok(g.context.digest.offset > 0); assert.ok(contextDigest(g));
  assert.throws(() => parseContextSummary(JSON.stringify({ ...empty, requirements: 'x'.repeat(7000) })), /过长/);
  assert.throws(() => parseContextSummary('{}'), /不完整/);
});
test('short conversations make no summary call and never truncate a message to its tail', async () => {
  const { w, g } = fixture(2); g.messages[0].text = '关键开头' + 'x'.repeat(11000) + '关键结尾';
  await compact(g, w, { generate: async () => { throw new Error('must not call'); } });
  assert.equal(conversationMessages(g, 'deepseek', w.agents)[0].content, g.messages[0].text);
  assert.match(conversationSystem(w.agents[0], g, w.agents), /用户最新要求优先/);
});
