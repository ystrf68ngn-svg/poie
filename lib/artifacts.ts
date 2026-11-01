export type Artifact = { source: string; language: string; kind: "html" | "svg" | "code"; filename: string };
export type ContentPart = { text: string; artifact?: never } | { artifact: Artifact; text?: never };
export function artifactFor(source: string, language = "", index = 1): Artifact {
  const lang = language.toLowerCase().trim();
  const kind = lang === "svg" || /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(source) ? "svg" : ["html", "htm"].includes(lang) || /^\s*(?:<!doctype html[^>]*>\s*)?<html[\s>]/i.test(source) ? "html" : "code";
  const extension = kind !== "code" ? kind : ({ javascript: "js", typescript: "ts", python: "py", bash: "sh", shell: "sh", markdown: "md" }[lang] || (/^[a-z0-9]{1,12}$/.test(lang) ? lang : "txt"));
  return { source, language: lang, kind, filename: `成果-${index}.${extension}` };
}
export function contentParts(text: string): ContentPart[] {
  const parts: ContentPart[] = []; let end = 0, index = 0;
  const pattern = /^```([^\n`]*)\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gm;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > end) parts.push({ text: text.slice(end, match.index) });
    parts.push({ artifact: artifactFor(match[2], match[1], ++index) }); end = match.index! + match[0].length;
  }
  if (end < text.length) {
    const rest = text.slice(end);
    if (!parts.length && /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(rest) && /<\/svg>\s*$/i.test(rest)) parts.push({ artifact: artifactFor(rest, "svg", 1) });
    else parts.push({ text: rest });
  }
  return parts;
}
export function hasArtifacts(text: string) { return contentParts(text).some(p => p.artifact); }
export const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export function previewDocument(artifact: Artifact, token: string): string {
  // This document is used only inside an opaque-origin iframe without allow-same-origin.
  // CSP goes first and cannot be weakened by a policy embedded in model output.
  const report = `(()=>{const send=(message)=>parent.postMessage({tongpinPreview:${JSON.stringify(token)},message},'*');addEventListener('error',e=>send(e.message||'脚本加载失败'));addEventListener('unhandledrejection',e=>send(String(e.reason||'未处理的脚本错误')));document.addEventListener('securitypolicyviolation',e=>send('预览已拦截外部资源：'+e.violatedDirective));})();`;
  const source = artifact.kind === "svg" ? `<style>html,body{margin:0;width:100%;height:100%;background:#081522}body{display:grid;place-items:center}body>svg{display:block;max-width:100%;max-height:100%;width:100%;height:100%}</style>${artifact.source.replace(/^\s*<\?xml[^>]*>/i, "")}` : artifact.source;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><script>${report}</script>${source}`;
}
