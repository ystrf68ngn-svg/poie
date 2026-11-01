import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const validFileId = id => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
export function safePdfName(title) { return (`poie-${String(title).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').slice(0, 80) || '报告'}`).replace(/[. ]+$/g, '') + '.pdf'; }
export function createPdfExporter({ BrowserWindow, directory }) {
  return {
    async create(html, title, signal) {
      if (typeof html !== 'string' || html.length > 1000000) throw new Error('报告正文过大，无法生成 PDF。');
      signal.throwIfAborted();
      const win = new BrowserWindow({ show: false, width: 1000, height: 1400, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: 'poie-pdf' } });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.webContents.on('will-frame-navigate', event => event.preventDefault());
      win.webContents.session.setPermissionRequestHandler((_w, _p, done) => done(false));
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'file://*/*'] }, (_details, done) => done({ cancel: true }));
      const abort = () => { if (!win.isDestroyed()) win.destroy(); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
        const safeTitle = String(title).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').slice(0,180);
        await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${safeTitle}</title>${html}`));
        signal.throwIfAborted();
        const bytes = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', preferCSSPageSize: true });
        signal.throwIfAborted();
        if (bytes.length < 5 || bytes.length > 20000000 || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('PDF 渲染没有生成有效文件。');
        const id = randomUUID(); await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(directory, id + '.pdf'), bytes, { mode: 0o600 });
        return { id, filename: safePdfName(title), mime: 'application/pdf', size: bytes.length };
      } finally { signal.removeEventListener('abort', abort); if (!win.isDestroyed()) win.destroy(); }
    },
    async read(id) {
      if (!validFileId(id)) throw new Error('文件引用无效。');
      return readFile(join(directory, id + '.pdf'));
    },
  };
}
