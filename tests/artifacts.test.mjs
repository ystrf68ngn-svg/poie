import test from 'node:test';
import assert from 'node:assert/strict';
import { contentParts, previewDocument, artifactFor, hasArtifacts } from '../lib/artifacts.ts';
test('existing SVG fences, raw SVG and HTML become previewable artifacts while prose stays text', () => {
  const parts = contentParts('这是动画\n```svg\n<svg><circle /></svg>\n```\n请检查效果。');
  assert.equal(parts.length, 3); assert.equal(parts[1].artifact.kind, 'svg'); assert.equal(parts[2].text, '请检查效果。');
  assert.equal(contentParts('<svg xmlns="http://www.w3.org/2000/svg"></svg>')[0].artifact.kind, 'svg');
  assert.equal(contentParts('```html\n<!doctype html><html><button>操作</button></html>\n```')[0].artifact.kind, 'html');
  assert.equal(hasArtifacts('```python\nprint(1)\n```'), true); assert.equal(artifactFor('print(1)', 'python').kind, 'code');
  assert.equal(hasArtifacts('```svg\n<svg>尚未生成完'), false);
});
test('preview document installs a restrictive CSP before untrusted output and reports actual errors', () => {
  const source = '<!doctype html><html><script>document.body.textContent="hello"</script></html>';
  const doc = previewDocument(artifactFor(source, 'html'), 'test-token');
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf(source));
  for (const policy of ["connect-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(doc.includes(policy));
  assert.ok(doc.includes('unhandledrejection')); assert.ok(doc.includes('securitypolicyviolation')); assert.ok(doc.includes(source));
});
