import test from 'node:test';
import assert from 'node:assert/strict';
import { apiBaseCandidates, normalizeBaseUrl, reasoningOptions } from '../lib/model-config.ts';
import { handleChat, handleModels } from '../lib/model-api.ts';
import { readChatStream } from '../lib/chat-client.ts';
const key = 'relay-test-only';
const request = (payload) => new Request('https://app.example/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const body = { provider: 'custom', baseUrl: 'https://relay.example/v1/chat/completions', format: 'openai', apiKey: key, model: 'claude-through-compatible-relay', system: '自然聊天', messages: [{ role: 'user', content: 'hello' }] };
const stream = () => new Response('data: {"choices":[{"delta":{"content":"实际接口回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
test('relay URL, protocol and model manufacturer are independent for discovery and chat', async () => {
  const models = await handleModels(request(body), async (url, options) => {
    assert.equal(url, 'https://relay.example/v1/models'); assert.equal(options.headers.Authorization, `Bearer ${key}`); assert.equal(options.headers['x-api-key'], undefined);
    return Response.json({ data: [{ id: body.model }, { id: 'gpt-model' }] });
  });
  assert.equal((await models.json()).models.length, 2);
  assert.equal(await readChatStream(await handleChat(request({ ...body, reasoning: 'high' }), async (url, options) => {
    assert.equal(url, 'https://relay.example/v1/chat/completions'); const payload = JSON.parse(options.body); assert.equal(payload.model, body.model); assert.equal(payload.reasoning_effort, 'high'); return stream();
  })), '实际接口回复');
});
test('connection protocol, rather than provider preset, selects authentication and stream decoder', async () => {
  const response = await handleChat(request({ ...body, provider: 'deepseek', format: 'anthropic', model: 'claude-sonnet-4-6', reasoning: 'medium' }), async (url, options) => {
    assert.equal(url, 'https://relay.example/v1/messages'); assert.equal(options.headers['x-api-key'], key); assert.equal(options.headers.Authorization, undefined);
    const payload = JSON.parse(options.body); assert.deepEqual(payload.thinking, { type: 'adaptive' }); assert.deepEqual(payload.output_config, { effort: 'medium' });
    return new Response('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\n\ndata: {"type":"message_stop"}\n\n');
  });
  assert.equal(await readChatStream(response), '你好');
});
test('DeepSeek thinking toggles and reasoning effort reach the actual upstream payload', async () => {
  for (const effort of ['auto', 'none', 'low', 'high', 'max']) {
    await readChatStream(await handleChat(request({ ...body, model: 'deepseek-flash', reasoning: effort }), async (_url, options) => {
      const payload = JSON.parse(options.body);
      if (effort === 'auto') { assert.equal(payload.thinking, undefined); assert.equal(payload.reasoning_effort, undefined); }
      else if (effort === 'none') { assert.deepEqual(payload.thinking, { type: 'disabled' }); assert.equal(payload.reasoning_effort, undefined); }
      else { assert.deepEqual(payload.thinking, { type: 'enabled' }); assert.equal(payload.reasoning_effort, effort); }
      return stream();
    }));
  }
});
test('API root normalization preserves version prefixes and rejects credentials and private targets', async () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1/models/'), 'https://api.deepseek.com/v1');
  for (const value of ['https://relay.example:8443/v1', 'https://key@relay.example/v1', 'https://relay.example/v1?key=secret', 'https://127.0.0.1/v1', 'https://0x7f000001/v1', 'https://[::1]/v1', 'https://foo.local/v1', 'https://localhost/v1']) {
    assert.throws(() => normalizeBaseUrl(value));
    assert.equal((await handleChat(request({ ...body, baseUrl: value }), () => { throw new Error('must not fetch'); })).status, 400);
  }
});
test('copied website, console and complete endpoint links normalize without manual path editing', () => {
  const bases = ['https://relay.example', 'https://relay.example/v1', 'https://relay.example/api/v1', 'https://relay.example/api'];
  for (const link of [' relay.example ', 'https://relay.example/', 'http://relay.example', 'https://relay.example/#/token', 'https://relay.example/console/token', 'https://relay.example/dashboard']) assert.deepEqual(apiBaseCandidates(link), bases);
  for (const link of ['relay.example/v1/', 'https://relay.example/v1/chat/completions', 'https://relay.example/v1/models/', 'https://relay.example/v1/messages', 'https://relay.example/v1/responses#example']) assert.deepEqual(apiBaseCandidates(link), ['https://relay.example/v1']);
  assert.deepEqual(apiBaseCandidates('https://relay.example/gateway/v2/openai'), ['https://relay.example/gateway/v2/openai']);
  assert.deepEqual(apiBaseCandidates('https://relay.example/chat/completions'), ['https://relay.example']);
  assert.deepEqual(apiBaseCandidates('https://relay.example/custom-api'), ['https://relay.example/custom-api', 'https://relay.example/custom-api/v1']);
  assert.deepEqual(apiBaseCandidates('https://relay.example/api'), ['https://relay.example/api', 'https://relay.example/api/v1']);
});
test('Codex reasoning options use the selected model capabilities, not a universal hardcoded list', () => {
  const models = [{ id: 'model-a', name: 'A', isDefault: true, reasoningEfforts: ['low', 'high'] }, { id: 'model-b', name: 'B', reasoningEfforts: ['medium'] }];
  assert.deepEqual(reasoningOptions('codex', '', models), ['auto', 'low', 'high']); assert.deepEqual(reasoningOptions('codex', 'model-b', models), ['auto', 'medium']);
});
