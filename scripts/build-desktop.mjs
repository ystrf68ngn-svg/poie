import { mkdir, cp, writeFile, readFile, rm, access, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { getUv } from '../desktop/downloads.mjs';
import { copyResearchLicenses } from './runtime-licenses.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv.slice(2).find(a => !a.startsWith('--')) || `${process.platform}-${process.arch}`;
if (!['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'].includes(target)) throw new Error('Unsupported desktop target');
const [platform, arch] = target.split('-');
const appRoot = join(root, '.desktop/app'), runtime = join(root, '.desktop/runtime');
const run = (bin, args) => new Promise((resolve, reject) => { const c = spawn(bin, args, { cwd: root, stdio: 'inherit' }); c.on('error', reject); c.on('exit', code => code === 0 ? resolve() : reject(new Error(`Build failed: ${code}`))); });
await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.local.config.ts']);
await mkdir(appRoot, { recursive: true }); await rm(runtime, { recursive: true, force: true }); await mkdir(runtime, { recursive: true });
await rm(join(appRoot, 'ui'), { recursive: true, force: true });
await cp(join(root, 'dist/local'), join(appRoot, 'ui'), { recursive: true });
await build({ entryPoints: [join(root, 'desktop/main.mjs')], outfile: join(appRoot, 'main.mjs'), platform: 'node', target: 'node24', bundle: true, format: 'esm', legalComments: 'linked', external: ['electron'], banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
// Workers must be real files outside app.asar on all supported desktop platforms.
await build({ entryPoints: [join(root, 'scripts/pdf-text-worker.mjs')], outfile: join(runtime, 'pdf-text-worker.mjs'), platform: 'node', target: 'node24', bundle: true, format: 'esm', legalComments: 'linked' });
await cp(join(root, 'desktop/preload.cjs'), join(appRoot, 'preload.cjs'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: 'poie-desktop', productName: 'poie', version: pkg.version, type: 'module', main: 'main.mjs', description: 'poie · 你的多模型群聊空间', author: 'poie contributors', private: true }, null, 2));
await cp(join(root, 'desktop/assets/third-party'), join(runtime, 'third-party'), { recursive: true });
await copyResearchLicenses(root, join(runtime, 'third-party'));
await cp(join(root, 'project-skills'), join(runtime, 'project-skills'), { recursive: true }); await mkdir(join(runtime, 'scripts'));
await cp(join(root, 'scripts/hy-memory-bridge.py'), join(runtime, 'scripts/hy-memory-bridge.py'));
const cachedUv = join(root, '.desktop/cache', target, platform === 'win32' ? 'uv.exe' : 'uv');
let uv; try { uv = await readFile(cachedUv); } catch { uv = await getUv(platform, arch, { progress: message => console.log(`uv ${target}: ${message}`) }); await mkdir(join(root, '.desktop/cache', target), { recursive: true }); await writeFile(cachedUv, uv, { mode: 0o755 }); }
await writeFile(join(runtime, platform === 'win32' ? 'uv.exe' : 'uv'), uv, { mode: 0o755 });
await cp(runtime, join(appRoot, 'runtime'), { recursive: true });
console.log(`Desktop source ready: ${target}`);
if (!process.argv.includes('--prepare-only')) {
  const builderArgs = ['node_modules/electron-builder/cli.js', '--config', 'desktop/electron-builder.cjs', platform === 'darwin' ? '--mac' : '--win', `--${arch}`, '--publish', 'never'];
  if (platform === 'darwin' || process.argv.includes('--dir')) builderArgs.push('--dir');
  // Optional local cache, checked against the official Electron package checksums.
  const electronVersion = pkg.devDependencies.electron, zipName = `electron-v${electronVersion}-${target}.zip`, zipPath = join(root, '.desktop/electron-zips', zipName);
  let cached = false; try { await access(zipPath); cached = true; } catch {}
  if (cached) {
    const hashes = JSON.parse(await readFile(join(root, 'node_modules/electron/checksums.json'), 'utf8'));
    if (createHash('sha256').update(await readFile(zipPath)).digest('hex') !== hashes[zipName]) throw new Error('Electron cache checksum mismatch');
    builderArgs.push(`--config.electronDist=${zipPath}`);
  }
  await run(process.execPath, builderArgs);
  if (platform === 'darwin' && !process.argv.includes('--dir')) {
    if (process.platform !== 'darwin') throw new Error('macOS 安装镜像需要在 Mac 构建。');
    const out = join(root, 'releases/desktop', arch === 'arm64' ? 'mac-arm64' : 'mac');
    // Include only this release's app, even if the build folder contains an older product name.
    const dmgRoot = join(root, '.desktop', `dmg-${arch}`);
    await rm(dmgRoot, { recursive: true, force: true }); await mkdir(dmgRoot, { recursive: true });
    await cp(join(out, 'poie.app'), join(dmgRoot, 'poie.app'), { recursive: true, verbatimSymlinks: true });
    await symlink('/Applications', join(dmgRoot, 'Applications'));
    await writeFile(join(dmgRoot, '安装说明.txt'), '将「poie」拖入 Applications（应用程序），再从应用程序中双击打开。\n不需要 Node.js、Python 或终端命令。\n本版本尚未经过 Apple 公证，正式公开发行需开发者签名与公证。\n');
    await run('/usr/bin/hdiutil', ['create', '-ov', '-volname', `poie ${pkg.version}`, '-srcfolder', dmgRoot, '-format', 'UDZO', '-imagekey', 'zlib-level=6', join(root, 'releases/desktop', `poie-${pkg.version}-mac-${arch}.dmg`)]);
  }
}
