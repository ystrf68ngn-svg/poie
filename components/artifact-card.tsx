"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Code2, Download, Eye, RotateCcw, Square, X } from "lucide-react";
import { isDesktop } from "@/lib/desktop";
import { previewDocument, type Artifact } from "@/lib/artifacts";

export default function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const desktop = isDesktop();
  const [previewUrl, setPreviewUrl] = useState("");
  const [open, setOpen] = useState(false), [tab, setTab] = useState<"preview" | "source">("preview");
  const [running, setRunning] = useState(true), [revision, setRevision] = useState(0), [status, setStatus] = useState("等待加载"), [failure, setFailure] = useState("");
  const dialog = useRef<HTMLDialogElement>(null), frame = useRef<HTMLIFrameElement>(null);
  const token = useMemo(() => globalThis.crypto.randomUUID(), [revision, open]);
  const document = useMemo(() => previewDocument(artifact, token), [artifact.source, artifact.kind, token]);
  const canPreview = artifact.kind !== "code";
  useEffect(() => { if (!desktop || !open) return; return window.tongpinDesktop!.onTask(task => { if (task.kind === "preview" && task.state === "error") setFailure(task.message); }); }, [desktop, open]);
  useEffect(() => {
    if (!desktop || !open || !running || tab !== "preview") return;
    let disposed = false, created = ""; setPreviewUrl("");
    void window.tongpinDesktop!.preview(document).then(url => {
      created = url;
      if (disposed) void window.tongpinDesktop!.releasePreview(url); else setPreviewUrl(url);
    }).catch(() => setFailure("无法打开成果预览，请关闭后重试。"));
    return () => { disposed = true; if (created) void window.tongpinDesktop!.releasePreview(created); };
  }, [desktop, document, open, running, tab]);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const listener = (event: MessageEvent) => { if (event.source === frame.current?.contentWindow && event.data?.tongpinPreview === token && typeof event.data.message === "string") setFailure(event.data.message.slice(0, 400)); };
    window.addEventListener("message", listener); return () => window.removeEventListener("message", listener);
  }, [open, token]);
  function download() {
    const url = URL.createObjectURL(new Blob([artifact.source], { type: artifact.kind === "svg" ? "image/svg+xml;charset=utf-8" : artifact.kind === "html" ? "text/html;charset=utf-8" : "text/plain;charset=utf-8" }));
    const link = globalThis.document.createElement("a"); link.href = url; link.download = artifact.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function show(preview: boolean) { setTab(preview ? "preview" : "source"); setRunning(true); setStatus("等待加载"); setFailure(""); setOpen(true); }
  return <div className="artifact-card">
    <div className="artifact-identity"><span className="artifact-symbol"><Code2 size={20} /></span><div><strong>{artifact.filename}</strong><span>{canPreview ? `${artifact.kind.toUpperCase()} · 可运行预览` : `${artifact.language || "文本"} · 源文件`}</span></div></div>
    <div className="artifact-actions">{canPreview && <button onClick={() => show(true)}><Eye size={14} />预览成果</button>}<button onClick={() => show(false)}><Code2 size={14} />源码</button><button onClick={download} aria-label={`下载 ${artifact.filename}`}><Download size={14} />下载</button></div>
    {open && <dialog ref={dialog} className="artifact-dialog" aria-label={`${artifact.filename} 成果检验`} onCancel={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <header><div><span className="panel-kicker">ARTIFACT / PLAYGROUND</span><h2>{artifact.filename}</h2></div><div className="artifact-window-actions"><button onClick={download}><Download size={15} />下载</button><button aria-label="关闭成果预览" onClick={() => setOpen(false)}><X size={20} /></button></div></header>
      <nav>{canPreview && <button aria-pressed={tab === "preview"} onClick={() => setTab("preview")}><Eye size={14} />预览</button>}<button aria-pressed={tab === "source"} onClick={() => setTab("source")}><Code2 size={14} />源码</button>{canPreview && <><span className="artifact-status" role="status">{failure ? "有运行提示" : !running ? "已停止" : status}</span><button aria-label="重新运行预览" onClick={() => { setRevision(x => x + 1); setRunning(true); setFailure(""); setStatus("等待加载"); }}><RotateCcw size={14} /></button><button aria-label="停止预览" onClick={() => setRunning(false)} disabled={!running}><Square size={13} /></button></>}</nav>
      {failure && <div className="artifact-error" role="alert">{failure}</div>}
      {tab === "source" ? <pre className="artifact-source"><code>{artifact.source}</code></pre> : running ? <iframe key={revision} ref={frame} title={`${artifact.filename} 隔离预览`} sandbox="allow-scripts" referrerPolicy="no-referrer" src={desktop ? previewUrl || "about:blank" : undefined} srcDoc={desktop ? undefined : document} onLoad={() => setStatus("预览已加载")} /> : <div className="artifact-stopped"><Square size={24} /><p>预览已停止</p><button className="button secondary" onClick={() => { setRevision(x => x + 1); setRunning(true); setStatus("等待加载"); }}>重新运行</button></div>}
      <footer>HTML / SVG 在隔离画布中运行，可操作检查。外部资源与网络请求已禁用；加载完成不代表功能已全部验收。其他源文件需在对应软件中运行。</footer>
    </dialog>}
  </div>;
}
