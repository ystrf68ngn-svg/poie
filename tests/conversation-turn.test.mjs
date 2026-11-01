import test from 'node:test';
import assert from 'node:assert/strict';
import { initialWorkspace, message, conversationSystem } from '../lib/workspace.ts';
import { memberTurn, cliConversationInput } from '../lib/conversation-turn.ts';
import { compactConversation, groupContextSystem } from '../lib/conversation-context.ts';
import { isStopRequest, runDiscussion, discussionDelay } from '../lib/discussion.ts';

function fixture() {
  const w = initialWorkspace(), g = w.groups[0], a = w.agents[0];
  g.messages = [message('user', '请做一个自行车 SVG 动画'), message(a.id, '这里是动画代码'), message('user', '你好')];
  return { w, g, a, human: g.messages.at(-1) };
}
test('ordinary replies end with the current human turn even after another agent answers an old question', () => {
  const { w, g, a, human } = fixture();
  g.messages.push(message('deepseek', '我继续补上刚才的自行车动画代码。'));
  const turn = memberTurn(g, a, w.agents, { userMessageId: human.id, mode: 'chat' });
  assert.equal(turn.query, '你好');
  assert.equal(turn.messages.at(-1).role, 'user');
  assert.equal(turn.messages.at(-1).content, '【本轮用户消息】\n你好\n【本轮用户消息结束】');
  assert.ok(turn.messages.slice(0, -1).some(m => m.content.includes('群成员 DeepSeek')));
  assert.equal(turn.messages.filter(m => m.content === '你好').length, 0);
  assert.match(turn.rules, /不继续回答旧问题/);
  assert.match(conversationSystem(a, g, w.agents), /不回答|不要回答旧问题/);
  const cli = cliConversationInput(turn.messages);
  assert.ok(cli.indexOf('先前对话') < cli.indexOf('本轮输入'));
  assert.match(cli.split('【本轮输入】')[1], /你好/);
  assert.doesNotMatch(cli.split('【本轮输入】')[1], /自行车/);
});
test('compacted goals remain background while a fresh greeting remains the explicit current input', async () => {
  const { w, g, a } = fixture();
  g.messages.splice(2, 0, ...Array.from({ length: 35 }, (_, i) => message(i % 2 ? a.id : 'user', `旧工作进度 ${i}`)));
  await compactConversation(g, w.agents, { signal: new AbortController().signal, provider: 'codex', model: '', generate: async () => JSON.stringify({ goal: '做自行车 SVG', requirements: '保留橙色', decisions: '', progress: '未完成', pending: '继续补代码', artifacts: '', questions: '' }), checkpoint: digest => { g.context = { digest }; } });
  const turn = memberTurn(g, a, w.agents, { userMessageId: g.messages.at(-1).id, mode: 'chat' });
  assert.match(groupContextSystem(g, w.agents, ''), /继续补代码/);
  assert.match(turn.rules, /历史摘要、待办/);
  assert.match(turn.messages.at(-1).content, /你好/);
  assert.doesNotMatch(turn.messages.at(-1).content, /补代码/);
});
test('explicit continue, plans, approved work and discussion keep separate turn instructions', () => {
  const { w, g, a, human } = fixture(); human.text = '继续刚才的动画';
  const chat = memberTurn(g, a, w.agents, { userMessageId: human.id, mode: 'chat' });
  assert.match(chat.messages.at(-1).content, /继续刚才的动画/);
  const plan = memberTurn(g, a, w.agents, { userMessageId: human.id, mode: 'plan' });
  assert.match(plan.rules, /仍需用户批准/);
  const task = memberTurn(g, a, w.agents, { userMessageId: human.id, mode: 'task', instruction: '补充车轮旋转' });
  assert.match(task.messages.at(-1).content, /本轮已批准的协作任务.*补充车轮旋转/s);
  const discuss = memberTurn(g, a, w.agents, { userMessageId: human.id, mode: 'discussion', turn: 4 });
  assert.match(discuss.messages.at(-1).content, /第 4 次发言/);
  assert.match(discuss.rules, /讨论不等于批准执行任务/);
  assert.throws(() => memberTurn(g, a, w.agents, { userMessageId: 'missing', mode: 'chat' }), /本轮用户消息不存在/);
});
test('a long discussion keeps its original topic explicit after that user message has been compacted', async () => {
  const { w, g, a } = fixture();
  const topic = message('user', '讨论如何坚持读书');
  g.messages = [topic, ...Array.from({ length: 55 }, (_, i) => message(i % 2 ? 'claude' : 'deepseek', `读书讨论 ${i}`))];
  await compactConversation(g, w.agents, { signal: new AbortController().signal, provider: 'codex', model: '', generate: async () => JSON.stringify({ goal: '讨论读书习惯', requirements: '', decisions: '', progress: '正在交流', pending: '', artifacts: '', questions: '' }), checkpoint: digest => { g.context = { digest }; } });
  assert.ok(g.context.digest.covered > 0);
  const turn = memberTurn(g, a, w.agents, { userMessageId: topic.id, mode: 'discussion', turn: 56 });
  assert.match(turn.messages.at(-1).content, /讨论如何坚持读书/);
  assert.ok(turn.messages.some(m => m.content.includes('读书讨论 54')));
  assert.equal(g.messages.length, 56);
});
test('only explicit human stop requests are controls, not questions, quotes or negations', () => {
  for (const text of ['停止', '停！', '停下来', '停一停', '请大家先停止讨论', '@所有人 停一下', '暂停一下', '别聊了', 'stop now', 'STOP', '结束讨论']) assert.equal(isStopRequest(text), true, text);
  for (const text of ['如何停止讨论？', '不要停止', '请解释“停止”的含义', '停止按钮是什么颜色', '代码中的 stop 方法', '```停止```', '你好']) assert.equal(isStopRequest(text), false, text);
});
test('discussion takes ordered turns, passes previous results forward and ends at the chosen round count', async () => {
  const history = [], observed = [];
  await runDiscussion({ members: ['one', 'two'], rounds: 3, signal: new AbortController().signal, between: async () => {}, speak: async (id, turn, round) => { observed.push({ id, turn, round, previous: history.at(-1) }); history.push(`${id}-${turn}`); } });
  assert.deepEqual(observed.map(v => v.id), ['one', 'two', 'one', 'two', 'one', 'two']);
  assert.equal(observed.at(-1).round, 3); assert.equal(observed[1].previous, 'one-1');
});
test('stop during an in-flight discussion prevents another member even if the provider returns late', async () => {
  const c = new AbortController(); let started, finish, calls = 0;
  const entered = new Promise(r => { started = r; });
  const result = runDiscussion({ members: ['one', 'two'], rounds: null, signal: c.signal, between: async () => {}, speak: async () => { calls++; started(); await new Promise(r => { finish = r; }); } });
  await entered; c.abort(); finish(); await assert.rejects(result, /abort/i); assert.equal(calls, 1);
});
test('stop between speakers cancels the wait, and a member error stops further calls without retries', async () => {
  const c = new AbortController(); let entered, calls = 0;
  const waiting = new Promise(r => { entered = r; });
  const result = runDiscussion({ members: ['one', 'two'], rounds: null, signal: c.signal, speak: async () => { calls++; }, between: async signal => { entered(); await discussionDelay(60000, signal); } });
  await waiting; c.abort(); await assert.rejects(result, /abort/i); assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(runDiscussion({ members: ['one', 'two'], rounds: 3, signal: new AbortController().signal, speak: async () => { calls++; throw new Error('upstream failed'); } }), /upstream failed/);
  assert.equal(calls, 1);
});
test('a stopped discussion does not restart and requires at least two distinct connected participants', async () => {
  const c = new AbortController(); c.abort(); let calls = 0;
  await assert.rejects(runDiscussion({ members: ['one', 'two'], rounds: 3, signal: c.signal, speak: async () => { calls++; } }), /abort/i);
  await assert.rejects(runDiscussion({ members: ['one', 'one'], rounds: 3, signal: new AbortController().signal, speak: async () => { calls++; } }), /至少需要两位/);
  assert.equal(calls, 0);
});
