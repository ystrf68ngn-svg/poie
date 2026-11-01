import { mkdir, writeFile, access, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { download, verifyDownload, archiveBinary } from './downloads.mjs';

export function createDependencies({ dataRoot, toolsRoot, uv, fetcher = fetch, update }) {
  let active, child;
  async function run(binary, args, env, { timeoutMs = 1200000, progress } = {}) {
    return new Promise((resolve, reject) => {
      child = spawn(binary, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '', output = '', lines = '', downloaded = 0;
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-1000000); });
      child.stderr.on('data', chunk => {
        tail = (tail + chunk).slice(-1500);
        // Report counts, never raw package-manager output or connection details.
        lines += chunk;
        let end; while ((end = lines.indexOf('\n')) >= 0) {
          const line = lines.slice(0, end).trim(); lines = lines.slice(end + 1);
          if (/^Downloaded [\w.-]+$/.test(line)) progress?.(`已下载 ${++downloaded} 项记忆依赖，正在准备其余组件…`);
          if (/^Prepared \d+ packages/.test(line)) progress?.('记忆依赖下载完成，正在安装…');
        }
        lines = lines.slice(-2000);
      });
      const timer = setTimeout(() => child?.kill('SIGTERM'), timeoutMs);
      child.once('error', () => { clearTimeout(timer); reject(new Error('组件准备工具无法启动，请重新安装poie。')); });
      child.once('close', code => { clearTimeout(timer); child = undefined; code === 0 ? resolve(output) : reject(new Error(/ENOSPC|No space left/.test(tail) ? '磁盘空间不足，请清理后重试。' : '组件准备未完成，请检查网络后重试。')); });
    });
  }
  async function putBinary(name, bytes) {
    await mkdir(toolsRoot, { recursive: true, mode: 0o700 });
    const target = join(toolsRoot, name), temp = target + '.' + randomUUID();
    await writeFile(temp, bytes, { mode: 0o700 }); await rename(temp, target);
    return target;
  }
  async function prepare(kind) {
    const progress = message => update({ kind, state: 'running', message });
    const options = { fetcher, progress };
    if (kind === 'memory') {
      progress('正在准备记忆引擎运行环境，首次下载可能需要几分钟…');
      await mkdir(dataRoot, { recursive: true, mode: 0o700 });
      const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(dataRoot, 'managed-python'), UV_CACHE_DIR: join(dataRoot, 'download-cache'), UV_NO_PROGRESS: '1', UV_PYTHON_DOWNLOADS: 'automatic', UV_NO_CONFIG: '1', UV_PYTHON_NO_REGISTRY: '1', UV_PYTHON_INSTALL_REGISTRY: '0', UV_PYTHON_INSTALL_BIN: '0', UV_HTTP_TIMEOUT: '300', UV_HTTP_RETRIES: '3' };
      const venv = join(dataRoot, 'python'), python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      try { await access(python); } catch {
        // Let pinned uv choose and verify its official Python build; prefetch the archive
        // with resumable range downloads instead of relying on a single long CDN stream.
        const choices = JSON.parse(await run(uv, ['python', 'list', '3.12', '--only-downloads', '--show-urls', '--output-format', 'json'], env));
        const choice = choices.find(item => item.implementation === 'cpython' && item.variant === 'default' && item.version_parts?.major === 3 && item.version_parts?.minor === 12);
        const url = choice?.url?.replace('https://releases.astral.sh/github/python-build-standalone/releases/download/', 'https://github.com/astral-sh/python-build-standalone/releases/download/');
        const match = typeof url === 'string' && url.match(/^https:\/\/github\.com\/astral-sh\/python-build-standalone\/releases\/download\/(\d{8})\/([^/?#]+)$/);
        if (!match) throw new Error('没有找到适合此电脑的官方 Python 组件。');
        const name = decodeURIComponent(match[2]); if (!/^[\w.+-]+$/.test(name)) throw new Error('Python 下载文件名无效。');
        const archiveRoot = join(dataRoot, 'python-archives'), folder = join(archiveRoot, match[1]), archive = join(folder, name);
        await mkdir(folder, { recursive: true });
        try { await access(archive); } catch { const bytes = await download(url, options); const temp = archive + '.tmp'; await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, archive); }
        progress('正在校验并安装专用 Python…');
        try { await run(uv, ['venv', '--python', '3.12', '--managed-python', venv], { ...env, UV_PYTHON_INSTALL_MIRROR: pathToFileURL(archiveRoot).href }); }
        catch (error) { await rm(archive, { force: true }); throw error; }
      }
      progress('正在下载并安装 Hy-Memory 依赖，首次下载内容较多，可以继续聊天…');
      await run(uv, ['pip', 'install', '--python', python, 'hy-memory==2.0.4', 'qdrant-client==1.20.0'], env, { timeoutMs: 2700000, progress });
      progress('正在验证记忆引擎…'); await run(python, ['-c', 'from importlib.metadata import version; assert version("hy-memory")=="2.0.4"; import qdrant_client'], env);
    } else if (kind === 'codex') {
      progress('正在读取 Codex 官方组件…');
      const meta = JSON.parse((await download('https://registry.npmjs.org/@openai%2fcodex/latest', { ...options, limit: 2_000_000 })).toString());
      const alias = meta.optionalDependencies?.[`@openai/codex-${process.platform}-${process.arch}`];
      const version = typeof alias === 'string' && alias.match(/^npm:@openai\/codex@([\w.-]+)$/)?.[1];
      if (!version) throw new Error('Codex 暂未提供此平台的组件。');
      const pkg = JSON.parse((await download(`https://registry.npmjs.org/@openai%2fcodex/${version}`, { ...options, limit: 2_000_000 })).toString());
      if (!/^sha512-[A-Za-z0-9+/=]+$/.test(pkg.dist?.integrity)) throw new Error('Codex 校验信息不可用。');
      const archive = await download(pkg.dist.tarball, options); verifyDownload(archive, pkg.dist.integrity.slice(7), 'sha512', 'base64');
      const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
      await putBinary(name, archiveBinary(archive, name, 'tar.gz'));
    } else if (kind === 'claude-code') {
      progress('正在读取 Claude Code 官方组件…');
      const root = 'https://downloads.claude.ai/claude-code-releases';
      const version = (await download(root + '/stable', { ...options, limit: 1000 })).toString().trim();
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Claude Code 下载服务暂不可用。');
      const manifest = JSON.parse((await download(`${root}/${version}/manifest.json`, { ...options, limit: 1000000 })).toString());
      const platform = `${process.platform}-${process.arch}`, checksum = manifest.platforms?.[platform]?.checksum;
      if (!/^[a-f0-9]{64}$/.test(checksum || '')) throw new Error('Claude Code 暂未提供此平台的组件。');
      const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
      const bytes = await download(`${root}/${version}/${platform}/${name}`, options); verifyDownload(bytes, checksum); await putBinary(name, bytes);
    } else throw new Error('未知组件。');
  }
  return {
    start(kind) {
      if (!['memory', 'codex', 'claude-code'].includes(kind)) throw new Error('未知组件。');
      if (active) throw new Error('已有组件正在准备，请等待完成。');
      active = kind; update({ kind, state: 'running', message: '正在准备…' });
      void prepare(kind).then(() => update({ kind, state: 'done', message: kind === 'memory' ? 'Hy-Memory 已就绪，可以配置 Embedding 并建立索引。' : '账号组件已就绪，请点击登录。' })).catch(e => update({ kind, state: 'error', message: e.message })).finally(() => { active = undefined; });
      return { message: '正在后台准备，可在桌面设置查看进度。' };
    },
    stop() { child?.kill('SIGTERM'); },
  };
}
