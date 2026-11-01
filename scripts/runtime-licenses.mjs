import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function copyResearchLicenses(root, destination) {
  await mkdir(destination, { recursive: true });
  const visited = new Set(), notices = [];
  async function copy(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const directory = join(root, 'node_modules', name);
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const licenses = (await readdir(directory)).filter(file => /^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(file));
    for (const file of licenses) await cp(join(directory, file), join(destination, `${name.replaceAll('/', '-')}-${file}`));
    notices.push(`${name}@${pkg.version}: ${pkg.license || 'see bundled license'}`);
    for (const dependency of Object.keys(pkg.dependencies || {})) await copy(dependency);
  }
  for (const name of ['linkedom', 'unpdf']) await copy(name);
  await writeFile(join(destination, 'WEB-RESEARCH.txt'), `Public web and PDF reader dependencies\n\n${notices.sort().join('\n')}\n\nunpdf includes Mozilla PDF.js (Apache-2.0); its bundled notices are preserved in pdf-text-worker.mjs.LEGAL.txt.\n`);
}
