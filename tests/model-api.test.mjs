import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChat, handleModels, modelRequestSchema } from '../lib/model-api.ts';
import { readChatStream } from '../lib/chat-client.ts';
const key = 'test-not-a-real-key';
const body = { provider: 'deepseek', model: 'chat-model', apiKey: key, system: '自然聊天', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: '你好' }, { role: 'user', content: '记得上一句吗' }] };
const request = (value = body, origin = 'https://example.test') => new Request('https://example.test/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(value) });
function streamResponse(text) { const bytes = new TextEncoder().encode(text); return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } }); }
const openAI = 'data: {"choices":[{"delta":{"content":"你好，小熊👋"},"finish_reason":null}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
test('Codex requires neither an OpenAI key nor a model ID, but cloud route cannot impersonate local Codex', async () => {
  assert.ok(modelRequestSchema.safeParse({ ...body, provider: 'codex', apiKey: undefined, model: '' }).success);
  assert.ok(!modelRequestSchema.safeParse({ ...body, apiKey: '', model: '' }).success);
  const response = await handleChat(request({ ...body, provider: 'codex', apiKey: undefined, model: '' }), () => { throw new Error('must not fetch'); });
  assert.equal(response.status, 409); assert.match((await response.json()).error, /本机/);
});
test('compatible vendors receive complete conversation and stream actual UTF-8 output', async () => {
  for (const provider of ['deepseek', 'gemini', 'qwen', 'moonshot']) {
    let captured;
    const response = await handleChat(request({ ...body, provider }), async (url, options) => { captured = { url, options, payload: JSON.parse(options.body) }; return streamResponse(openAI); });
    const deltas = []; assert.equal(await readChatStream(response, value => deltas.push(value)), '你好，小熊👋');
    assert.ok(captured.url.endsWith('/chat/completions')); assert.equal(captured.options.headers.Authorization, `Bearer ${key}`); assert.equal(captured.payload.stream, true); assert.equal(captured.payload.messages[0].role, 'system'); assert.equal(captured.payload.messages[2].content, '你好'); assert.deepEqual(deltas, ['你好，小熊👋']);
  }
});
test('Claude uses Messages protocol with editable role and genuine text deltas', async () => {
  let payload;
  const response = await handleChat(request({ ...body, provider: 'anthropic', system: 'Claude 当前负责统筹规划' }), async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages'); assert.equal(options.headers['x-api-key'], key); payload = JSON.parse(options.body);
    return streamResponse('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"我们先聊聊"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  assert.equal(await readChatStream(response), '我们先聊聊'); assert.equal(payload.system, 'Claude 当前负责统筹规划'); assert.deepEqual(payload.messages, body.messages);
});
test('bad keys report a real error without leaking keys or inventing a reply', async () => {
  const response = await handleChat(request(), async () => Response.json({ error: { message: `invalid ${key}` } }, { status: 401 }));
  assert.equal(response.status, 422); const error = (await response.json()).error; assert.match(error, /API Key 无效/); assert.ok(!error.includes(key));
});
test('interrupted, empty, and token-limited upstream streams never count as completed replies', async () => {
  const cases = [
    'data: {"choices":[{"delta":{"content":"未完成"}}]}\n\n',
    'data: [DONE]\n\n',
    'data: {"choices":[{"delta":{"content":"一部分"}}]}\n\ndata: {"choices":[{"finish_reason":"length"}]}\n\n',
    'data: {"error":{"message":"provider unavailable"}}\n\n',
  ];
  for (const stream of cases) await assert.rejects(() => handleChat(request(), async () => streamResponse(stream)).then(r => readChatStream(r)));
});
test('model discovery uses authenticated vendor endpoint and filters non-chat IDs', async () => {
  const response = await handleModels(request({ provider: 'anthropic', apiKey: key }), async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/models'); assert.equal(options.headers['x-api-key'], key);
    return Response.json({ data: [{ id: 'claude-example', display_name: 'Claude Example' }, { id: 'embedding-model' }] });
  });
  assert.deepEqual((await response.json()).models, [{ id: 'claude-example', name: 'Claude Example' }]);
});
test('cross-origin requests and oversized bodies are rejected before reaching a provider', async () => {
  const never = () => { throw new Error('must not fetch'); };
  assert.equal((await handleChat(request(body, 'https://unrelated.test'), never)).status, 403);
  assert.equal((await handleChat(request({ ...body, messages: [{ role: 'user', content: 'x'.repeat(180001) }] }), never)).status, 400);
});

test('model discovery and chat use the redirect mode supported by Workers', async () => {
  const workerFetch = async (_url, options) => {
    if (options.redirect === 'error') throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    assert.equal(options.redirect, 'manual');
    return options.method === 'POST' ? streamResponse(openAI) : Response.json({ data: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] });
  };
  const models = await handleModels(request({ provider: 'deepseek', apiKey: key }), workerFetch);
  assert.equal(models.status, 200); assert.equal((await models.json()).models[0].id, 'deepseek-flash');
  assert.equal(await readChatStream(await handleChat(request(), workerFetch)), '你好，小熊👋');
});
test('provider redirects are reported without following their target', async () => {
  let calls = 0;
  const redirect = async (_url, options) => { calls++; assert.equal(options.redirect, 'manual'); return new Response(null, { status: 302, headers: { Location: 'https://unrelated.test/' } }); };
  const models = await handleModels(request({ provider: 'deepseek', apiKey: key }), redirect);
  const chat = await handleChat(request(), redirect);
  for (const response of [models, chat]) { assert.equal(response.status, 502); assert.equal((await response.json()).code, 'MODEL_REDIRECT'); }
  assert.equal(calls, 2);
});

test('explicit API paths returning HTML report a response error instead of a network failure', async () => {
  const relay = { ...body, provider: 'custom', baseUrl: 'https://relay.example/v1', format: 'openai' };
  const html = async () => new Response('<!doctype html><title>API dashboard</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  for (const handler of [handleModels, handleChat]) {
    const response = await handler(request(relay), html);
    assert.equal(response.status, 502);
    const data = await response.json();
    assert.equal(data.code, 'MODEL_RESPONSE_FORMAT');
    assert.equal(data.suggestedBaseUrl, undefined);
    assert.match(data.error, /网页/);
    assert.ok(!data.error.includes(key));
  }
  const nested = await handleModels(request({ ...relay, baseUrl: 'https://relay.example/custom-api' }), html);
  assert.equal((await nested.json()).suggestedBaseUrl, undefined);
});

test('invalid model-list responses are distinct from transport errors', async () => {
  for (const invalid of ['not-json', '{"data":{}}', 'null']) {
    const response = await handleModels(request({ ...body, baseUrl: 'https://api.deepseek.com/v1' }), async () => new Response(invalid));
    assert.equal((await response.json()).code, 'MODEL_RESPONSE_FORMAT');
  }
  const valid = await handleModels(request(), async () => Response.json({ data: [null, { id: 'valid-model' }] }));
  assert.deepEqual((await valid.json()).models, [{ id: 'valid-model', name: 'valid-model' }]);
});

test('a copied relay homepage is discovered using read-only same-origin requests and returns the saved base', async () => {
  const calls = [];
  const response = await handleModels(request({ provider: 'custom', apiKey: key, baseUrl: 'relay.example' }), async (url, options) => {
    calls.push(url);
    assert.equal(options.method || 'GET', 'GET'); assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, `Bearer ${key}`); assert.equal(options.redirect, 'manual');
    return url.endsWith('/v1/models') ? Response.json({ data: [{ id: 'relay-model' }] }) : new Response('<html>console</html>', { headers: { 'content-type': 'text/html' } });
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { baseUrl: 'https://relay.example/v1', models: [{ id: 'relay-model', name: 'relay-model' }] });
  assert.deepEqual(calls, ['https://relay.example/models', 'https://relay.example/v1/models']);
});

test('already usable roots and explicit version prefixes are preserved, while common API prefixes are found', async () => {
  for (const [base, workingPath, expectedCalls] of [
    ['https://api.deepseek.com', '/models', 1],
    ['https://relay.example', '/api/v1/models', 3],
    ['https://relay.example', '/api/models', 4],
    ['https://relay.example/api', '/api/v1/models', 2],
    ['https://relay.example/gateway/v2/chat/completions', '/gateway/v2/models', 1],
  ]) {
    let calls = 0;
    const response = await handleModels(request({ provider: 'custom', apiKey: key, baseUrl: base }), async url => {
      calls++; return new URL(url).pathname === workingPath ? Response.json({ data: [{ id: 'relay-model' }] }) : Response.json({ error: 'missing route' }, { status: 404 });
    });
    assert.equal(response.status, 200); assert.equal(calls, expectedCalls);
    assert.equal((await response.json()).baseUrl, new URL(workingPath.replace(/\/models$/, ''), base).href.replace(/\/$/, ''));
  }
});

test('old homepage connections resolve before sending a conversation, without retrying a paid chat', async () => {
  const calls = [];
  const response = await handleChat(request({ ...body, provider: 'custom', baseUrl: 'https://relay.example' }), async (url, options) => {
    calls.push([url, options.method || 'GET']);
    if (!options.method) {
      assert.equal(options.body, undefined);
      return url.endsWith('/v1/models') ? Response.json({ data: [{ id: body.model }] }) : new Response('<html>console</html>', { headers: { 'content-type': 'text/html' } });
    }
    assert.deepEqual(JSON.parse(options.body).messages.slice(1), body.messages);
    return streamResponse(openAI);
  });
  assert.equal(await readChatStream(response), '你好，小熊👋');
  assert.deepEqual(calls, [['https://relay.example/models', 'GET'], ['https://relay.example/v1/models', 'GET'], ['https://relay.example/v1/chat/completions', 'POST']]);
});

test('authorization, quota and redirect failures stop discovery without probing more paths or sending chat', async () => {
  for (const status of [401, 403, 429, 500, 302]) for (const handler of [handleModels, handleChat]) {
    let calls = 0;
    const response = await handler(request({ ...body, provider: 'custom', baseUrl: 'https://relay.example' }), async (_url, options) => {
      calls++; assert.equal(options.method || 'GET', 'GET'); assert.equal(options.redirect, 'manual');
      return Response.json({ error: { message: `upstream rejected ${key}` } }, { status, headers: { Location: 'https://elsewhere.example/v1' } });
    });
    assert.equal(calls, 1); assert.ok(!response.ok); assert.ok(!(await response.text()).includes(key));
  }
});

test('no model catalog still allows a manually configured chat route, while discovery fails clearly and finitely', async () => {
  const relay = { ...body, provider: 'custom', baseUrl: 'https://relay.example/custom-api' };
  const calls = [];
  const response = await handleChat(request(relay), async (url, options) => {
    calls.push([url, options.method || 'GET']);
    return options.method === 'POST' ? streamResponse(openAI) : Response.json({ error: 'not found' }, { status: 404 });
  });
  assert.equal(await readChatStream(response), '你好，小熊👋');
  assert.deepEqual(calls, [['https://relay.example/custom-api/models', 'GET'], ['https://relay.example/custom-api/v1/models', 'GET'], ['https://relay.example/custom-api/chat/completions', 'POST']]);
  let probes = 0;
  const failed = await handleModels(request({ ...relay, baseUrl: 'https://relay.example' }), async () => { probes++; return new Response('<html>console</html>'); });
  assert.equal(probes, 4); assert.equal(failed.status, 502); assert.equal((await failed.json()).code, 'MODEL_API_NOT_FOUND');
});
