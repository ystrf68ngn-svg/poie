import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createProjectRuntime } from '../scripts/project-runtime.mjs';
import { createLocalServer } from '../scripts/local-server.mjs';
import { initialWorkspace, deleteGroup, restoreWorkspace } from '../lib/workspace.ts';
import { parseMemoryImport, memoryContext } from '../lib/memory.ts';
import { handleApiUsage, normalizeTokenUsage, codexQuota } from '../lib/usage.ts';
import { handleChat } from '../lib/model-api.ts';
import { readChatStream } from '../lib/chat-client.ts';

test('deleting the active/last group survives reload without recreating data; defaults work API-only', () => {
  const ws = initialWorkspace(); assert.equal(ws.agents.find(a => a.id === ws.groups[0].ownerId).provider, 'deepseek');
  const deleted = deleteGroup(ws, ws.activeGroup); assert.equal(deleted.groups.length, 0); assert.equal(deleted.activeGroup, '');
  assert.equal(restoreWorkspace(JSON.stringify(deleted)).groups.length, 0); assert.equal(ws.groups.length, 1);
  const second = { ...ws.groups[0], id: 'second' }; const two = { ...ws, groups: [...ws.groups, second] }; assert.equal(deleteGroup(two, ws.activeGroup).activeGroup, 'second');
});
test('memory migration parses real export shapes, protects secrets, and deduplicates content', () => {
  const hy = JSON.stringify({ memories: { normal: [{ content: '我喜欢蓝色', source: 'hy-memory' }], schema: [], proactive: [] } });
  assert.equal(parseMemoryImport(hy, 'hy.json')[0].text, '我喜欢蓝色');
  const gpt = JSON.stringify([{ title: '偏好', current_node: 'b', mapping: { a: { parent: null, message: { author: { role: 'user' }, content: { parts: ['喜欢简洁界面'] } } }, b: { parent: 'a', message: { author: { role: 'assistant' }, content: { parts: ['好的'] } } }, other: { parent: 'a', message: { author: { role: 'assistant' }, content: { parts: ['不应导入的分支'] } } } } }]);
  const text = parseMemoryImport(gpt, 'conversations.json')[0].text; assert.match(text, /喜欢简洁/); assert.doesNotMatch(text, /不应导入/);
  assert.throws(() => parseMemoryImport('{"apiKey":"nothing"}', 'config.json'), /没有识别/);
  assert.throws(() => parseMemoryImport('sk-' + 'x'.repeat(30), 'secret.txt'), /密钥/);
});
test('project memory persists, is isolated by workspace, revoked recall sends nothing, edits and deletes apply', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tongpin-runtime-')); t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = createProjectRuntime(root); const req = (path, body) => runtime.handle('/api/' + path, { workspaceId: 'one', ...body });
  const saved = await req('memory/save', { item: { title: '偏好', text: '我最喜欢的颜色是蓝色' } });
  const reloaded = createProjectRuntime(root); assert.equal((await reloaded.handle('/api/memory/list', { workspaceId: 'one' })).items.length, 1);
  assert.equal((await reloaded.handle('/api/memory/list', { workspaceId: 'two' })).items.length, 0);
  assert.equal((await req('project/context', { query: '颜色', memoryEnabled: false, skillIds: [] })).memory, '');
  assert.match((await req('project/context', { query: '颜色', memoryEnabled: true, skillIds: ['hy-memory'] })).memory, /蓝色/);
  assert.match((await req('project/context', { memoryEnabled: false, skillIds: ['hy-memory'] })).instructions, /poie记忆/);
  await req('memory/save', { id: saved.item.id, item: { title: '偏好', text: '我喜欢绿色' } });
  assert.doesNotMatch((await req('project/context', { query: '喜欢颜色', memoryEnabled: true })).memory, /蓝色/);
  const imported = await req('memory/import', { filename: 'memory.json', text: JSON.stringify({ items: [{ text: '我喜欢绿色' }, { text: '更喜欢中文回答' }] }), consent: true }); assert.equal(imported.added, 1);
  await assert.rejects(req('memory/import', { filename: 'memory.txt', text: '测试', consent: false }), /确认/);
  await assert.rejects(req('memory/list', { workspaceId: '../escape' }));
  await req('memory/delete', { id: saved.item.id }); assert.doesNotMatch((await req('project/context', { query: '喜欢颜色', memoryEnabled: true })).memory, /绿色/);
});
test('skill installation stages a pinned source, requires confirmation, and is injected only when selected', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tongpin-skills-')); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0; const sha = 'a'.repeat(40);
  const fetcher = async url => { calls++; if (url.endsWith('/repo')) return Response.json({ default_branch: 'main' }); if (url.includes('/commits/')) return Response.json({ sha }); if (url.includes('/git/trees/')) return Response.json({ tree: [{ path: 'skills/writer/SKILL.md', type: 'blob', mode: '100644', size: 50 }] }); assert.match(url, new RegExp(sha)); return new Response('---\nname: writer\n---\n回答应提供一段示例。'); };
  const runtime = createProjectRuntime(root, fetcher);
  await assert.rejects(runtime.handle('/api/skills/preview', { url: 'https://evil.test/skill' })); assert.equal(calls, 0);
  const preview = await runtime.handle('/api/skills/preview', { url: 'https://github.com/owner/repo/tree/main/skills/writer' });
  await assert.rejects(runtime.handle('/api/skills/install', { token: preview.token }), /确认/);
  await runtime.handle('/api/skills/install', { token: preview.token, consent: true });
  assert.equal((await runtime.handle('/api/project/context', { workspaceId: 'one', skillIds: [], memoryEnabled: false })).instructions, '');
  assert.match((await runtime.handle('/api/project/context', { workspaceId: 'one', skillIds: [preview.id], memoryEnabled: false })).instructions, /一段示例/);
  assert.equal(JSON.parse(await readFile(join(root, 'skills', preview.id, 'manifest.json'))).commit, sha);
});
test('usage consent gates every account read and unsupported relays never receive the official key', async t => {
  let queries = 0;
  const { server, stop } = createLocalServer({ port: 0, quota: async () => { queries++; return { kind: 'windows' }; } }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(stop);
  const url = `http://127.0.0.1:${server.address().port}`; const headers = { origin: url, 'Content-Type': 'application/json', 'X-Tongpin-Client': 'tongpin' };
  assert.equal((await fetch(`${url}/api/usage`, { method: 'POST', headers, body: JSON.stringify({ provider: 'codex' }) })).status, 403); assert.equal(queries, 0);
  assert.equal((await fetch(`${url}/api/usage`, { method: 'POST', headers, body: JSON.stringify({ provider: 'codex', consent: true }) })).status, 200); assert.equal(queries, 1);
  let network = 0; const fetcher = async (url, init) => { network++; assert.equal(url, 'https://api.deepseek.com/user/balance'); assert.equal(init.redirect, 'manual'); return Response.json({ balance_infos: [{ currency: 'CNY', total_balance: '12.34' }] }); };
  const request = body => new Request('https://tongpin.test/api/usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await handleApiUsage(request({ baseUrl: 'https://api.deepseek.com', apiKey: 'test' }), fetcher)).status, 403); assert.equal(network, 0);
  const relay = await handleApiUsage(request({ baseUrl: 'https://relay.example.com/v1', apiKey: 'test', consent: true }), fetcher); assert.equal((await relay.json()).kind, 'unavailable'); assert.equal(network, 0);
  const official = await handleApiUsage(request({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test', consent: true }), fetcher); assert.equal((await official.json()).balances[0].total, '12.34'); assert.equal(network, 1);
});
test('actual streaming usage is propagated only when requested; missing quota is not fabricated', async () => {
  assert.equal(codexQuota({}).kind, 'unavailable'); assert.equal(normalizeTokenUsage({}), undefined);
  assert.deepEqual(normalizeTokenUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 2 }, true), { inputTokens: 32, outputTokens: 5, cachedTokens: 20, totalTokens: 37 });
  const usage = { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 };
  for (const consent of [false, true]) {
    const response = await handleChat(new Request('https://tongpin.test/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'deepseek', model: 'test', apiKey: 'test', system: 'test', includeUsage: consent, messages: [{ role: 'user', content: 'hello' }] }) }), async (_url, init) => { assert.equal(!!JSON.parse(init.body).stream_options?.include_usage, consent); return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`); });
    let actual; assert.equal(await readChatStream(response, undefined, value => actual = value), 'hello'); assert.equal(actual?.totalTokens, consent ? 20 : undefined);
  }
});
