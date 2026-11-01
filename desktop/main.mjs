import { app, BrowserWindow, Menu, protocol, session, ipcMain, shell, dialog, safeStorage, net, nativeTheme } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { PREVIEW_CSP } from '../lib/artifacts.ts';
import { createLocalServer } from '../scripts/local-server.mjs';
import { createWebResearch, extractPdf } from '../scripts/web-research.mjs';
import { createProjectRuntime } from '../scripts/project-runtime.mjs';
import { createVault } from './vault.mjs';
import { createDependencies } from './dependencies.mjs';
import { createAccountLogin } from './login.mjs';
import { createPdfExporter, safePdfName, validFileId } from './pdf-export.mjs';
import { resetCodexConnection } from '../scripts/codex-chat.mjs';
import { resetClaudeConnection } from '../scripts/account-connections.mjs';

// Keep the original storage / Keychain identity so renaming the product preserves saved data and keys.
app.setName('Tongpin');
app.setAboutPanelOptions({ applicationName: 'poie' });
nativeTheme.themeSource = 'light';
if (process.env.TONGPIN_DESKTOP_DATA) app.setPath('userData', process.env.TONGPIN_DESKTOP_DATA);
protocol.registerSchemesAsPrivileged([{ scheme: 'tongpin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }, { scheme: 'tongpin-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
let window, service, dependencies, login, quitting = false;
const tasks = {};
const previews = new Map();
const pdfJobs = new Map();
const dataRoot = join(app.getPath('userData'), 'project');
const toolsRoot = join(app.getPath('userData'), 'tools');
process.env.TONGPIN_TOOLS_DIR = toolsRoot;
function update(task) { tasks[task.kind] = task; if (task.state === 'done') { resetCodexConnection(); resetClaudeConnection(); } window?.webContents.send('desktop:task', task); }
function trusted(event) { if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !event.senderFrame.url.startsWith('tongpin://app/')) throw new Error('无效的桌面请求来源。'); }
function handle(name, fn) { ipcMain.handle(name, (event, ...args) => { trusted(event); return fn(...args); }); }
async function openWeb(url) { let u; try { u = new URL(url); } catch { return; } if (u.protocol !== 'https:' || u.username || u.password) return; await shell.openExternal(url); }
function createWindow() {
  window = new BrowserWindow({ width: 1380, height: 900, minWidth: 820, minHeight: 600, title: 'poie', icon: join(app.getAppPath(), 'ui', 'poie-icon.png'), backgroundColor: '#faf9f6', show: false, webPreferences: { preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(({ url }) => { void openWeb(url)?.catch(() => {}); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('tongpin://app/')) event.preventDefault(); });
  window.webContents.on('will-frame-navigate', (event, details) => { const url = typeof details === 'string' ? details : details?.url || event.url; if (url && !url.startsWith('tongpin://app/') && !url.startsWith('tongpin-preview://artifact/')) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = undefined; previews.clear(); });
  window.webContents.on('did-fail-load', (_event, code, description, url, main) => { if (!main && url.startsWith('tongpin-preview:') && code !== -3) update({ kind: 'preview', state: 'error', message: `成果预览加载失败（${code}：${description}），请重试。` }); });
  window.webContents.on('render-process-gone', () => { if (!quitting) dialog.showErrorBox('poie页面已停止', '请重新打开应用。已保存的聊天和记忆不会被删除。'); });
  void window.loadURL('tongpin://app/');
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const assets = app.isPackaged ? join(process.resourcesPath, 'runtime') : join(app.getAppPath(), 'runtime');
    const uv = join(assets, process.platform === 'win32' ? 'uv.exe' : 'uv');
    dependencies = createDependencies({ dataRoot, toolsRoot, uv, fetcher: (...args) => net.fetch(...args), update });
    login = createAccountLogin({ openExternal: openWeb, update });
    const token = randomBytes(32).toString('hex');
    service = createLocalServer({ port: 0, fetcher: (...args) => net.fetch(...args), staticRoot: join(app.getAppPath(), 'ui'), bridgeToken: token, trustedOrigins: [], login: provider => login.start(provider), runtime: createProjectRuntime(dataRoot, (...args) => net.fetch(...args), assets), research: createWebResearch({ pdf: (bytes, signal) => extractPdf(bytes, signal, join(assets, 'pdf-text-worker.mjs')) }) });
    service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
    const origin = `http://127.0.0.1:${service.server.address().port}`;
    protocol.handle('tongpin', async request => {
      const url = new URL(request.url); if (url.host !== 'app' || !['GET', 'HEAD', 'POST'].includes(request.method)) return new Response('Forbidden', { status: 403 });
      const headers = { 'X-Tongpin-Client': 'tongpin', 'X-Tongpin-Session': token, Origin: origin, 'Content-Type': 'application/json' };
      const response = await fetch(origin + url.pathname + url.search, { method: request.method, headers, body: request.method === 'POST' ? await request.arrayBuffer() : undefined, signal: request.signal, redirect: 'manual' });
      const out = new Headers(response.headers);
      if (out.get('content-type')?.includes('text/html')) out.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src tongpin-preview:; object-src 'none'; base-uri 'none'; form-action 'none'");
      return new Response(response.body, { status: response.status, headers: out });
    });
    protocol.handle('tongpin-preview', request => {
      const url = new URL(request.url), content = url.host === 'artifact' && request.method === 'GET' ? previews.get(url.pathname.slice(1)) : null;
      return new Response(content || '预览已关闭。', { status: content ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PREVIEW_CSP, 'X-Content-Type-Options': 'nosniff' } });
    });
    session.defaultSession.setPermissionRequestHandler((_wc, _p, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', (_event, item) => item.setSaveDialogOptions({ title: '保存poie文件' }));
    handle('desktop:preview', source => { if (typeof source !== 'string' || source.length > 1000000 || previews.size > 12) throw new Error('预览内容过长或打开的预览过多。'); const id = randomUUID(); previews.set(id, source); return `tongpin-preview://artifact/${id}`; });
    handle('desktop:release-preview', url => { if (typeof url === 'string' && url.startsWith('tongpin-preview://artifact/')) previews.delete(url.slice('tongpin-preview://artifact/'.length)); });
    const pdfExporter = createPdfExporter({ BrowserWindow, directory: join(dataRoot, 'deliverables') });
    handle('desktop:create-pdf', async (html, title, jobId) => {
      if (!validFileId(jobId) || pdfJobs.has(jobId) || pdfJobs.size > 2) throw new Error('PDF 任务无效或已有任务在运行。');
      const controller = new AbortController(); pdfJobs.set(jobId, controller);
      const timeout = setTimeout(() => controller.abort(), 30000);
      try { return await pdfExporter.create(html, title, controller.signal); }
      finally { clearTimeout(timeout); pdfJobs.delete(jobId); }
    });
    handle('desktop:cancel-pdf', id => { pdfJobs.get(id)?.abort(); });
    handle('desktop:save-deliverable', async (id, filename) => {
      const bytes = await pdfExporter.read(id);
      const result = await dialog.showSaveDialog(window, { title: '保存报告 PDF', defaultPath: safePdfName(filename?.replace(/^poie-/, '').replace(/\.pdf$/i, '') || '报告'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (result.canceled || !result.filePath) return { saved: false };
      await writeFile(result.filePath, bytes); return { saved: true };
    });
    handle('desktop:info', () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, tasks }));
    handle('desktop:prepare', kind => dependencies.start(kind));
    handle('desktop:login', provider => login.start(provider));
    handle('desktop:code', (provider, code) => login.submit(provider, code));
    handle('desktop:cancel-login', provider => login.cancel(provider));
    handle('desktop:open-data', () => shell.openPath(app.getPath('userData')));
    const vault = createVault(join(app.getPath('userData'), 'connections.encrypted'), safeStorage);
    handle('desktop:load-secrets', () => vault.load());
    handle('desktop:save-secrets', value => vault.save(value));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: 'poie', submenu: [{ role: 'about', label: '关于 poie' }, { type: 'separator' }, { role: 'hide', label: '隐藏 poie' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit', label: '退出 poie' }] }] : []),
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '显示', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]));
    createWindow();
  }).catch(error => { console.error('Desktop startup:', error.message); dialog.showErrorBox('poie无法启动', '应用文件可能不完整。请重新安装后再打开，个人数据不会被安装程序删除。'); app.quit(); });
  app.on('activate', () => { if (!window && service) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { quitting = true; for (const c of pdfJobs.values()) c.abort(); dependencies?.stop(); login?.stop(); service?.stop(); });
}
