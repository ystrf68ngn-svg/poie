import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('local Codex adapter reuses login, isolates tools, decodes Unicode, tolerates recovered errors, and cancels its child', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tongpin-adapter-test-'));
  const binary = join(dir, 'codex'), capture = join(dir, 'capture.json');
  const original = { binary: process.env.TONGPIN_CODEX_BIN, key: process.env.OPENAI_API_KEY };
  t.after(async () => { if (original.binary === undefined) delete process.env.TONGPIN_CODEX_BIN; else process.env.TONGPIN_CODEX_BIN = original.binary; if (original.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = original.key; await rm(dir, { recursive: true, force: true }); });
  await writeFile(binary, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nif (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }\nlet prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => prompt += chunk);\nprocess.stdin.on('end', async () => {\n writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, prompt, cwd: process.cwd(), inheritedKey: !!process.env.OPENAI_API_KEY }));\n if (prompt.includes('hold-test-child')) { setInterval(() => {}, 500); return; }\n process.stdout.write(JSON.stringify({type:'error',message:'Reconnecting'})+'\\n');\n const text=Buffer.from(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'你好，小熊👋'}})+'\\n'+JSON.stringify({type:'turn.completed'})+'\\n');\n for(let i=0;i<text.length;i++){process.stdout.write(text.subarray(i,i+1));await new Promise(r=>setTimeout(r,1));}\n});\n`);
  await chmod(binary, 0o700); process.env.TONGPIN_CODEX_BIN = binary; process.env.OPENAI_API_KEY = 'test-key-must-not-reach-child';
  const { runCodexChat, codexStatus } = await import('../scripts/codex-chat.mjs');
  assert.equal((await codexStatus()).authenticated, true);
  const body = { provider: 'codex', model: '', reasoning: 'high', system: '当前职责：统筹规划', messages: [{ role: 'user', content: 'hello' }] };
  assert.equal(await runCodexChat(body, new AbortController().signal), '你好，小熊👋');
  const details = JSON.parse(await readFile(capture, 'utf8'));
  assert.ok(details.args.includes('model_reasoning_effort="high"')); assert.equal(details.inheritedKey, false); assert.ok(details.args.includes('--ephemeral')); assert.ok(details.args.includes('--ignore-user-config')); assert.ok(details.args.includes('read-only')); assert.ok(details.args.includes('features.shell_tool=false')); assert.match(details.prompt, /当前职责：统筹规划/); assert.match(details.prompt, /hello/); assert.ok(details.cwd.includes('tongpin-chat-'));
  const controller = new AbortController(); const pending = runCodexChat({ ...body, messages: [{ role: 'user', content: 'hold-test-child' }] }, controller.signal);
  const timer = setTimeout(() => controller.abort(), 150); await assert.rejects(pending, /已停止/); clearTimeout(timer);
  // A cancelled child releases the concurrency slot and does not prevent later replies.
  assert.equal(await runCodexChat(body, new AbortController().signal), '你好，小熊👋');
});
