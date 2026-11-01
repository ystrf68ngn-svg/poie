import { parentPort, workerData } from 'node:worker_threads';
import { getDocumentProxy } from 'unpdf';

// Runs in a bounded worker, not the desktop UI/main thread. No PDF actions or scripts run.
try {
  const pdf = await getDocumentProxy(new Uint8Array(workerData), { isEvalSupported: false, useSystemFonts: false, disableFontFace: true, stopAtErrors: true, verbosity: 0 });
  const pages = [], maxPages = Math.min(pdf.numPages, 100);
  let length = 0;
  for (let n = 1; n <= maxPages && length < 180000; n++) {
    const page = await pdf.getPage(n), content = await page.getTextContent();
    const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
    pages.push(`[PDF 第 ${n} 页]\n${text}`); length += text.length;
    page.cleanup();
  }
  const totalPages = pdf.numPages;
  await pdf.cleanup();
  parentPort.postMessage({ text: pages.join('\n\n'), pages: totalPages });
} catch { parentPort.postMessage({ error: 'PDF 无法读取文本，可能是扫描件、加密文件或不支持的编码。' }); }
