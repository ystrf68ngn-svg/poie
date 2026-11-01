import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalServer, SITE_ORIGIN } from '../scripts/local-server.mjs';
import { allowedAuthUrl, createAccountLogin } from '../desktop/login.mjs';
import { download, verifyDownload, archiveBinary } from '../desktop/downloads.mjs';
import { resetCodexConnection } from '../scripts/codex-chat.mjs';

test('desktop backend rejects browser access without its private session; authorized requests use the injected network stack', async t => {
  let requested = 0;
  const service = createLocalServer({ port: 0, bridgeToken: 'test-session-only', trustedOrigins: [], fetcher: async url => { requested++; assert.equal(String(url), 'https://api.deepseek.com/models'); return Response.json({ data: [{ id: 'deepseek-chat' }] }); } });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening'); t.after(service.stop);
  const origin = `http://127.0.0.1:${service.server.address().port}`;
  const headers = { origin, 'Content-Type': 'application/json', 'X-Tongpin-Client': 'tongpin' };
  const body = JSON.stringify({ provider: 'deepseek', apiKey: 'test-only', baseUrl: 'https://api.deepseek.com', format: 'openai' });
  assert.equal((await fetch(origin + '/api/models', { method: 'POST', headers, body })).status, 403);
  assert.equal((await fetch(origin + '/api/models', { method: 'POST', headers: { ...headers, 'X-Tongpin-Session': 'test-session-only', origin: SITE_ORIGIN }, body })).status, 403);
  assert.equal(requested, 0);
  const response = await fetch(origin + '/api/models', { method: 'POST', headers: { ...headers, 'X-Tongpin-Session': 'test-session-only' }, body });
  assert.equal(response.status, 200); assert.equal((await response.json()).models[0].id, 'deepseek-chat'); assert.equal(requested, 1);
});

test('component downloads reject untrusted redirects, oversized content and checksum changes', async () => {
  let calls = 0;
  await assert.rejects(download('https://github.com/example', { fetcher: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://untrusted.example/runtime' } }); } }), /官方来源/);
  assert.equal(calls, 1);
  await assert.rejects(download('https://github.com/example', { limit: 3, fetcher: async () => new Response('too long') }), /大小限制/);
  const content = Buffer.from('verified official binary');
  verifyDownload(content, createHash('sha256').update(content).digest('hex'));
  assert.throws(() => verifyDownload(Buffer.from('changed'), createHash('sha256').update(content).digest('hex')), /校验失败/);
  assert.throws(() => archiveBinary(Buffer.alloc(70000), 'uv.exe', 'zip'), /ZIP/);
});

test('archive installation selects a regular binary and ignores symlinks and paths', () => {
  const record = (name, type, content) => { const bytes = Buffer.from(content); const header = Buffer.alloc(512); header.write(name); header.write(bytes.length.toString(8).padStart(11, '0'), 124); header.write(type, 156); return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]); };
  const archive = gzipSync(Buffer.concat([record('package/codex', '2', '../../unexpected'), record('package/vendor/bin/codex', '0', 'real-binary'), Buffer.alloc(1024)]));
  assert.equal(archiveBinary(archive, 'codex', 'tar.gz').toString(), 'real-binary');
  assert.throws(() => archiveBinary(archive, 'claude', 'tar.gz'), /没有/);
});

test('GUI login opens only complete official OAuth URLs, keeps auth logs private and confirms actual status', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tongpin-desktop-login-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'codex'); const old = process.env.TONGPIN_CODEX_BIN;
  await writeFile(binary, `#!${process.execPath}\nif (process.argv.includes('status')) console.log('Logged in using ChatGPT'); else { process.stdout.write('https://auth.openai.com/oauth/'); setTimeout(() => { console.log('authorize?test=1'); console.error('private-auth-log'); }, 80); setTimeout(() => process.exit(0), 160); }\n`, { mode: 0o700 });
  process.env.TONGPIN_CODEX_BIN = binary; resetCodexConnection(); t.after(() => { if (old) process.env.TONGPIN_CODEX_BIN = old; else delete process.env.TONGPIN_CODEX_BIN; resetCodexConnection(); });
  const opened = [], tasks = [];
  let complete; const done = new Promise(resolve => complete = resolve);
  const login = createAccountLogin({ openExternal: async url => opened.push(url), update: task => { tasks.push(task); if (task.state === 'done' || task.state === 'error') complete(); } }); t.after(login.stop);
  await login.start('codex'); await done;
  assert.deepEqual(opened, ['https://auth.openai.com/oauth/authorize?test=1']);
  assert.equal(tasks.at(-1).state, 'done'); assert.ok(!JSON.stringify(tasks).includes('private-auth-log'));
  assert.equal(allowedAuthUrl('https://auth.openai.com.attacker.example/oauth', 'codex'), false);
  assert.equal(allowedAuthUrl('https://user:password@claude.ai/oauth', 'claude-code'), false);
  assert.equal(allowedAuthUrl('file:///private/test', 'codex'), false);
});


test('large official components resume failed ranges and return exactly the verified bytes', async () => {
  const original = Buffer.alloc(8_000_100, 73); original[1000000] = 29; let retried = false, ranges = 0;
  const fetcher = async (_url, options) => {
    if (!options.headers.Range) return new Response(original, { headers: { 'content-length': String(original.length), 'accept-ranges': 'bytes' } });
    ranges++;
    const [, first, last] = options.headers.Range.match(/bytes=(\d+)-(\d+)/);
    if (+first > 0 && !retried) { retried = true; throw new Error('transient connection failure'); }
    return new Response(original.subarray(+first, +last + 1), { status: 206, headers: { 'content-range': `bytes ${first}-${last}/${original.length}` } });
  };
  const result = await download('https://registry.npmjs.org/component.tgz', { fetcher });
  assert.deepEqual(result, original); assert.ok(retried); assert.equal(ranges, 13);
});


test('desktop starts without touching system credentials; opted-in vault writes are serialized and can be removed', async t => {
  const { createVault } = await import('../desktop/vault.mjs');
  const root = await mkdtemp(join(tmpdir(), 'tongpin-vault-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const vault = createVault(join(root, 'vault'), { isAsyncEncryptionAvailable: async () => { calls++; return true; }, encryptStringAsync: async text => Buffer.from(text.split('').reverse().join('')), decryptStringAsync: async bytes => ({ result: bytes.toString().split('').reverse().join(''), shouldReEncrypt: false }) });
  assert.equal(await vault.load(), null); assert.equal(calls, 0);
  await Promise.all([vault.save({ keys: { demo: 'old-test-only' } }), vault.save({ keys: { demo: 'new-test-only' } })]);
  assert.equal((await vault.load()).keys.demo, 'new-test-only');
  await vault.save(null); const before = calls; assert.equal(await vault.load(), null); assert.equal(calls, before);
});
