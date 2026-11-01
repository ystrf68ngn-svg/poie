// Explicit integration smoke: real Hy-Memory SDK + local deterministic embedding fixture, no paid API.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const dir = await mkdtemp(join(tmpdir(), 'tongpin-hy-smoke-'));
let requests = 0;
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks)); requests++;
  assert.equal(req.url, '/v1/embeddings'); assert.equal(body.model, 'test-embedding');
  const input = Array.isArray(body.input) ? body.input : [body.input];
  const data = input.map((text, index) => ({ object: 'embedding', index, embedding: Array.from({ length: 64 }, (_, i) => i === 0 ? 1 : (String(text).includes('蓝色') && i === 1 ? 0.5 : 0.01)) }));
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data, model: 'test-embedding', usage: { prompt_tokens: 1, total_tokens: 1 } }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const config = { model: 'test-embedding', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test-only', dimensions: 64 };
const call = body => new Promise((resolveValue, reject) => {
  const child = spawn(resolve(process.env.TONGPIN_TEST_PYTHON || '.tongpin/python/bin/python'), ['scripts/hy-memory-bridge.py'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Hy SDK timeout')); }, 60000);
  child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
  child.on('close', (code, signal) => { clearTimeout(timer); if (code !== 0) reject(new Error(body.action + ': exit=' + code + ', signal=' + signal + ', ' + out + '\n' + err.slice(-4000))); else { try { resolveValue(JSON.parse(out)); } catch { reject(new Error(body.action + ': invalid JSON, bytes=' + out.length + ', output=' + out + ', stderr=' + err.slice(-1500))); } } });
  child.stdin.end(JSON.stringify({ ...body, config, directory: dir, workspaceId: 'integration-test' }));
});
try {
  assert.equal((await call({ action: 'status' })).version, '2.0.4');
  const added = await call({ action: 'add', items: [{ id: 'one', title: '测试偏好', text: '用户最喜欢蓝色界面' }] }); assert.equal(added.items.length, 1);
  const result = await call({ action: 'search', query: '用户喜欢蓝色吗' }); assert.ok(result.memories.normal.some(m => m.content.includes('蓝色'))); assert.ok(requests >= 2);
  console.log('PASS: Hy-Memory 2.0.4 real SDK writes and recalls a persisted memory through the configured embedding endpoint.');
} finally { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); }
