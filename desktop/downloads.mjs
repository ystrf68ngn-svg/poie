import { createHash } from 'node:crypto';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'registry.npmjs.org', 'downloads.claude.ai']);
export async function download(url, { fetcher = fetch, limit = 450_000_000, progress = () => {}, signal = AbortSignal.timeout(1200000), parallel = true } = {}) {
  let response;
  for (let i = 0; i < 6; i++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !DOWNLOAD_HOSTS.has(parsed.hostname)) throw new Error('下载地址不属于官方来源。');
    response = await fetcher(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'Tongpin-Desktop' } });
    if (response.status >= 300 && response.status < 400) { url = new URL(response.headers.get('location'), url).href; await response.body?.cancel(); continue; }
    break;
  }
  if (!response?.ok) throw new Error(`官方下载暂时不可用（${response?.status || '网络错误'}），请稍后重试。`);
  const total = Number(response.headers.get('content-length'));
  if (total > limit) { await response.body?.cancel(); throw new Error('下载文件超出大小限制。'); }
  if (parallel && total > 8_000_000 && response.headers.get('accept-ranges') === 'bytes') {
    await response.body?.cancel();
    const controller = new AbortController(), rangeSignal = AbortSignal.any([signal, controller.signal]);
    const output = Buffer.alloc(total), count = 12, width = Math.ceil(total / count); let received = 0, last = 0;
    const parts = await Promise.allSettled(Array.from({ length: count }, async (_, i) => {
      try {
        const start = i * width, end = Math.min(total - 1, start + width - 1);
        let position = start;
        for (let attempt = 0; attempt < 3 && position <= end; attempt++) {
          try {
            const part = await fetcher(url, { redirect: 'manual', signal: rangeSignal, headers: { Range: `bytes=${position}-${end}`, 'User-Agent': 'Tongpin-Desktop' } });
            if (part.status !== 206 || part.headers.get('content-range') !== `bytes ${position}-${end}/${total}`) { await part.body?.cancel(); throw new Error('分段下载不可用。'); }
            for await (const chunk of part.body) {
              if (position + chunk.length > end + 1) throw new Error('下载长度不匹配。');
              output.set(chunk, position); position += chunk.length; received += chunk.length;
              if (Date.now() - last > 500) { progress(`正在下载 · ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`); last = Date.now(); }
            }
            if (position !== end + 1) throw new Error('下载文件不完整。');
          } catch (error) { rangeSignal.throwIfAborted(); if (attempt === 2) throw error; }
        }
      } catch (error) { controller.abort(); throw error; }
    }));
    if (parts.every(p => p.status === 'fulfilled')) return output;
    signal.throwIfAborted();
    return download(url, { fetcher, limit, progress, signal, parallel: false });
  }
  const chunks = []; let size = 0, last = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Error('下载文件超出大小限制。'); chunks.push(Buffer.from(chunk)); if (Date.now() - last > 500) { progress(`正在下载 · ${(size / 1048576).toFixed(1)} MB`); last = Date.now(); } }
  if (total && size !== total) throw new Error('下载文件不完整。请重试。');
  return Buffer.concat(chunks);
}
export function verifyDownload(bytes, expected, algorithm = 'sha256', encoding = 'hex') {
  if (!expected || createHash(algorithm).update(bytes).digest(encoding) !== expected) throw new Error('文件完整性校验失败，未安装。请重试。');
}
// Extract only one expected regular file, never unpack archive paths into the filesystem.
export function archiveBinary(bytes, name, format) {
  if (format === 'tar.gz') {
    const tar = gunzipSync(bytes, { maxOutputLength: 800_000_000 }); let longName = '';
    for (let offset = 0; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512); if (header.every(b => b === 0)) break;
      const string = (start, end) => header.subarray(start, end).toString().replace(/\0.*$/s, '');
      const size = parseInt(string(124, 136).trim(), 8); if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('无效的下载压缩包。');
      const type = string(156, 157), path = longName || [string(345, 500), string(0, 100)].filter(Boolean).join('/');
      const content = tar.subarray(offset + 512, offset + 512 + size); longName = type === 'L' ? content.toString().replace(/\0.*$/s, '') : '';
      if (['', '0'].includes(type) && path.split('/').at(-1) === name) return Buffer.from(content);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
  } else if (format === 'zip') {
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw new Error('无效的 ZIP 文件。');
    let at = bytes.readUInt32LE(end + 16);
    for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
      if (bytes.readUInt32LE(at) !== 0x02014b50) break;
      const length = bytes.readUInt16LE(at + 28), path = bytes.subarray(at + 46, at + 46 + length).toString();
      if (path.split('/').at(-1) === name) {
        const local = bytes.readUInt32LE(at + 42), start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28), compressed = bytes.subarray(start, start + bytes.readUInt32LE(at + 20));
        const method = bytes.readUInt16LE(at + 10);
        if (method === 0) return Buffer.from(compressed);
        if (method === 8) return inflateRawSync(compressed, { maxOutputLength: 450_000_000 });
        throw new Error('不支持的压缩格式。');
      }
      at += 46 + length + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    }
  }
  throw new Error(`下载包中没有 ${name}。`);
}
export const UV_VERSION = '0.13.5';
export async function getUv(platform, arch, options = {}) {
  const target = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc' }[`${platform}-${arch}`];
  if (!target) throw new Error('暂不支持此系统架构。');
  const format = platform === 'win32' ? 'zip' : 'tar.gz', name = `uv-${target}.${format}`, url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${name}`;
  const checksum = (await download(url + '.sha256', { ...options, limit: 4096 })).toString().trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('官方校验清单格式异常。');
  const bytes = await download(url, options); verifyDownload(bytes, checksum);
  return archiveBinary(bytes, platform === 'win32' ? 'uv.exe' : 'uv', format);
}
