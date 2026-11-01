import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createLocalServer, SITE_ORIGIN } from '../scripts/local-server.mjs';
import { readChatStream } from '../lib/chat-client.ts';

test('loopback bridge allows the app, rejects unrelated origins/hosts, and routes Codex without an API key', async t => {
  let called = 0;
  const { server, stop } = createLocalServer({ port: 0, models: async () => [{id:"local-model",name:"Local Model",reasoningEfforts:["low","high"]}], status: async () => ({ available: true, authenticated: true }), chat: async body => { called++; assert.equal(body.apiKey, undefined); assert.equal(body.messages[0].content, 'hello'); return '测试桩回复'; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(stop);
  const url = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({ provider: 'codex', model: '', system: '自然聊天', messages: [{ role: 'user', content: 'hello' }] });
  const headers = { 'content-type': 'application/json', 'X-Tongpin-Client': 'tongpin', origin: url };
  assert.equal((await fetch(`${url}/api/codex/status`, { headers: { 'X-Tongpin-Client': 'tongpin' } })).status, 200);
  assert.equal((await fetch(`${url}/api/codex/status`)).status, 403);
  assert.equal((await fetch(`${url}/api/codex/models`)).status, 403);
  const catalog = await fetch(`${url}/api/codex/models`, { headers: { 'X-Tongpin-Client': 'tongpin', origin: SITE_ORIGIN } }); assert.equal((await catalog.json()).models[0].id, 'local-model');
  assert.equal((await fetch(`${url}/api/chat`, { method: 'POST', headers: { ...headers, origin: 'https://unrelated.test' }, body })).status, 403);
  const rebindingStatus = await new Promise((resolve, reject) => { const req = httpRequest(`${url}/api/chat`, { method: 'POST', headers: { ...headers, host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(body); });
  assert.equal(rebindingStatus, 403);
  assert.equal((await fetch(`${url}/api/chat`, { method: 'POST', headers: { ...headers, 'X-Tongpin-Client': '' }, body })).status, 403);
  const response = await fetch(`${url}/api/chat`, { method: 'POST', headers, body }); assert.equal(await readChatStream(response), '测试桩回复'); assert.equal(called, 1);
  const preflight = await fetch(`${url}/api/chat`, { method: 'OPTIONS', headers: { origin: SITE_ORIGIN } }); assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), SITE_ORIGIN); assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
  const cloud = await fetch(`${url}/api/chat`, { method: 'POST', headers: { ...headers, origin: SITE_ORIGIN }, body }); assert.equal(await readChatStream(cloud), '测试桩回复'); assert.equal(called, 2);
});
test('stopping the browser request aborts the running local Codex adapter', async t => {
  let entered, cancelled;
  const started = new Promise(resolve => { entered = resolve; });
  const aborted = new Promise(resolve => { cancelled = resolve; });
  const { server, stop } = createLocalServer({ port: 0, chat: async (_body, signal) => { entered(); await new Promise((_, reject) => { signal.addEventListener('abort', () => { cancelled(); reject(new Error('cancelled')); }, { once: true }); }); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(stop);
  const url = `http://127.0.0.1:${server.address().port}`, controller = new AbortController();
  const pending = fetch(`${url}/api/chat`, { method: 'POST', signal: controller.signal, headers: { origin: url, 'X-Tongpin-Client': 'tongpin', 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'codex', system: 'test', messages: [{ role: 'user', content: 'hello' }] }) }).catch(e => e);
  await started; controller.abort(); await pending;
  await Promise.race([aborted, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('adapter was not cancelled')), 1500); timer.unref(); })]);
});
