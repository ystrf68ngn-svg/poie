import test from 'node:test';
import assert from 'node:assert/strict';
import { runTeamTasks, teamHandoff } from '../lib/team-work.ts';

test('team work delivers collected data before charting, then passes both outputs to reporting', async () => {
  const tasks = ['收集数据', '制作图表', '撰写报告'].map(title => ({ title })), seen = [];
  const result = await runTeamTasks(tasks, new AbortController().signal, async (task, previous) => {
    seen.push({ title: task.title, previous: previous.map(d => d.answer) });
    return { task, answer: `${task.title}的实际交付` };
  });
  assert.deepEqual(seen[0].previous, []);
  assert.deepEqual(seen[1].previous, ['收集数据的实际交付']);
  assert.deepEqual(seen[2].previous, ['收集数据的实际交付', '制作图表的实际交付']);
  assert.equal(result.length, 3);
});
test('team handoff preserves full upstream content and identifies missing work as missing', () => {
  const full = '数据行\n'.repeat(3000) + '最后一行';
  const handoff = teamHandoff([{ task: { title: '采集' }, answer: full }, { task: { title: '制图' }, error: '来源未能读取' }]);
  assert.ok(handoff.includes(full)); assert.match(handoff, /未完成：来源未能读取/);
});
test('stopping an active task blocks the next task even if its provider returns late', async () => {
  const c = new AbortController(); let entered, finish, calls = 0;
  const started = new Promise(r => { entered = r; });
  const run = runTeamTasks([{ title: '采集' }, { title: '制图' }], c.signal, async task => { calls++; entered(); await new Promise(r => { finish = r; }); return { task, answer: 'late' }; });
  await started; c.abort(); finish(); await assert.rejects(run, /abort/i); assert.equal(calls, 1);
});
