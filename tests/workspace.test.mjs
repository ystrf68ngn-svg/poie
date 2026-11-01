import test from 'node:test';
import assert from 'node:assert/strict';
import { initialWorkspace, parsePlan, stopGroup, restoreWorkspace, exportMarkdown, message, resolveRecipients, conversationMessages, conversationSystem } from '../lib/workspace.ts';

function planFor(group) { return parsePlan(JSON.stringify({ title: '协作', summary: '用户明确要求分工', tasks: [{ title: '整理', description: '整理需求', agentId: 'claude' }, { title: '核对', description: '核对约束', agentId: 'atlas' }] }), group); }
test('fresh workspace uses real chat, no fabricated messages or tasks, and no fixed occupations', () => {
  const w = initialWorkspace(); assert.equal(w.mode, 'live'); assert.equal(w.version, 2);
  assert.equal(w.groups[0].messages.length, 0); assert.equal(w.groups[0].plans.length, 0);
  assert.ok(w.agents.every(a => a.role === '通用助手' && !a.prompt));
  assert.equal(w.agents.find(a => a.id === 'atlas').provider, 'codex');
});
test('hello reaches the owner, mentions reach selected members, and Claude can be owner', () => {
  const w = initialWorkspace(), g = w.groups[0];
  assert.deepEqual(resolveRecipients('hello', 'owner', g, w.agents).map(a => a.id), [g.ownerId]);
  assert.deepEqual(resolveRecipients('@Claude 和 @Gemini 来讨论', 'owner', g, w.agents).map(a => a.id), ['claude', 'gemini']);
  assert.equal(resolveRecipients('@所有人 你好', 'owner', g, w.agents).length, 4);
  assert.deepEqual(resolveRecipients('hello', 'deepseek', g, w.agents).map(a => a.id), ['deepseek']);
  g.ownerId = 'claude'; const a = w.agents.find(a => a.id === 'claude'); a.role = '统筹规划'; a.prompt = '请优先梳理全局约束';
  assert.deepEqual(resolveRecipients('hello', 'owner', g, w.agents).map(a => a.id), ['claude']);
  const system = conversationSystem(a, g, w.agents);
  assert.match(system, /当前职责：统筹规划/); assert.match(system, /用户指定的群主/); assert.match(system, /普通聊天/); assert.match(system, /请优先梳理全局约束/);
  assert.doesNotMatch(system, /只输出 JSON/);
  assert.match(conversationSystem(a, g, w.agents, 'plan'), /用户明确选择了分工协作/);
});
test('history preserves conversation, distinguishes other agents, and excludes demo/error/unfinished replies', () => {
  const w = initialWorkspace(), g = w.groups[0];
  g.messages = [message('user', '我是小熊'), message('atlas', '你好，小熊'), message('claude', '我们可以讨论'), message('user', '你记得我叫什么吗'), message('atlas', '假的演示', { demo: true }), message('atlas', '尚未完成', { pending: true }), message('atlas', '失败', { failed: true }), message('system', '系统通知', { kind: 'system' })];
  const history = conversationMessages(g, 'atlas', w.agents);
  assert.equal(history.length, 4); assert.equal(history[1].role, 'assistant'); assert.equal(history[2].role, 'user'); assert.match(history[2].content, /Claude/); assert.equal(history.at(-1).content, '你记得我叫什么吗');
});
test('model plans require approval, valid members, and bounded nonempty tasks', () => {
  const g = initialWorkspace().groups[0];
  const raw = { title: '方案', summary: '方向', status: 'approved', tasks: [{ title: '研究', description: '提供建议', agentId: 'gemini', status: 'done' }] };
  const p = parsePlan('```json\n' + JSON.stringify(raw) + '\n```', g);
  assert.equal(p.status, 'pending'); assert.equal(p.tasks[0].status, 'pending'); assert.equal(p.mode, 'live');
  raw.tasks[0].agentId = 'unknown'; assert.throws(() => parsePlan(JSON.stringify(raw), g), /非群成员/);
  assert.throws(() => parsePlan('hello', g));
  for (const tasks of [[], Array(7).fill({ title: 'x', description: 'y', agentId: 'atlas' }), [{ title: ' ', description: 'b', agentId: 'atlas' }]]) assert.throws(() => parsePlan(JSON.stringify({ title: 'x', summary: 'y', tasks }), g));
});
test('stop and reload preserve completed results and cancel outstanding work', () => {
  const w = initialWorkspace(), g = w.groups[0], plan = planFor(g); g.plans.push(plan); plan.status = 'approved';
  plan.tasks[0] = { ...plan.tasks[0], status: 'done', result: '真实交付' }; plan.tasks[1].status = 'running';
  g.messages.push(message('atlas', '部分回复', { pending: true }));
  const stopped = stopGroup(g); assert.equal(stopped.plans[0].status, 'cancelled'); assert.equal(stopped.plans[0].tasks[0].result, '真实交付'); assert.equal(stopped.plans[0].tasks[1].status, 'cancelled'); assert.equal(plan.status, 'approved');
  const restored = restoreWorkspace(JSON.stringify(w)); assert.equal(restored.mode, 'live'); assert.equal(restored.groups[0].plans[0].status, 'cancelled'); assert.equal(restored.groups[0].messages[0].pending, false); assert.equal(restored.groups[0].messages[0].text, '部分回复');
});
test('v1 migration preserves custom roles, history and exports, switching OpenAI to local Codex', () => {
  const w = initialWorkspace(); w.version = 1; w.mode = 'demo'; w.agents[0] = { ...w.agents[0], name: 'Atlas', provider: 'openai', model: 'old-id' };
  w.agents[1].role = '总指挥'; w.agents[1].prompt = '用户自定义职责';
  const g = w.groups[0], plan = planFor(g); plan.mode = 'demo'; g.plans.push(plan); g.messages.push(message('atlas', '旧演示', { demo: true, planId: plan.id }));
  const restored = restoreWorkspace(JSON.stringify(w)); assert.equal(restored.mode, 'live'); assert.equal(restored.agents[0].provider, 'codex'); assert.equal(restored.agents[0].name, 'Codex'); assert.equal(restored.agents[0].model, '');
  assert.equal(restored.agents[1].role, '总指挥'); assert.equal(restored.agents[1].prompt, '用户自定义职责'); assert.equal(restored.groups[0].plans[0].status, 'cancelled');
  assert.equal(restored.groups[0].messages.length, 1); const md = exportMarkdown(restored.groups[0], restored.agents); assert.match(md, /旧演示/); assert.match(md, /Claude/); assert.doesNotMatch(md, /apiKey/);
});
