import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPdfExporter, validFileId, safePdfName } from '../desktop/pdf-export.mjs';

test('PDF export stores actual bytes, blocks external requests and rejects path traversal',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'poie-pdf-'));t.after(()=>rm(directory,{recursive:true,force:true}));let win;
  class MockWindow{constructor(options){assert.equal(options.show,false);assert.equal(options.webPreferences.sandbox,true);win=this;this.webContents={on:(_event,fn)=>{let prevented=false;fn({preventDefault:()=>{prevented=true;}});assert.ok(prevented);},setWindowOpenHandler:fn=>{assert.equal(fn({}).action,'deny');},session:{setPermissionRequestHandler:()=>{},webRequest:{onBeforeRequest:(_filter,fn)=>fn({},result=>assert.equal(result.cancel,true))}},printToPDF:async()=>Buffer.from('%PDF-1.7\nactual rendered content')};}async loadURL(url){assert.ok(url.startsWith('data:text/html'));assert.ok(decodeURIComponent(url).includes("connect-src 'none'"));assert.ok(decodeURIComponent(url).includes('<title>'));}isDestroyed(){return !!this.destroyed;}destroy(){this.destroyed=true;}}
  const exporter=createPdfExporter({BrowserWindow:MockWindow,directory});const file=await exporter.create('<p>报告</p>','../报告',new AbortController().signal);
  assert.ok(validFileId(file.id));assert.equal(file.mime,'application/pdf');assert.ok(file.size>5);assert.ok(win.destroyed);assert.ok((await exporter.read(file.id)).subarray(0,5).toString()==='%PDF-');await assert.rejects(exporter.read('../secret'));assert.ok(!safePdfName('../报告').includes('/'));
});
test('stopping PDF creation prevents a saved success, even if rendering returns late',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'poie-pdf-stop-'));t.after(()=>rm(directory,{recursive:true,force:true}));const c=new AbortController();
  class MockWindow{constructor(){this.webContents={on:()=>{},setWindowOpenHandler:()=>{},session:{setPermissionRequestHandler:()=>{},webRequest:{onBeforeRequest:()=>{}}},printToPDF:async()=>{c.abort();return Buffer.from('%PDF-1.7\nlate');}};}async loadURL(){}isDestroyed(){return !!this.destroyed;}destroy(){this.destroyed=true;}}
  await assert.rejects(createPdfExporter({BrowserWindow:MockWindow,directory}).create('<p>report</p>','report',c.signal));
});
