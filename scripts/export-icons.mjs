import sharp from 'sharp';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Format / size export only; all artwork comes from the approved generated master.
const source = 'desktop/assets/poie-eternal-master.png';
const iconset = '.desktop/poie.iconset';
await mkdir(iconset, { recursive: true });
await sharp(source).ensureAlpha().resize(1024, 1024).png().toFile('desktop/assets/icon.png');
await sharp(source).ensureAlpha().resize(256, 256).png().toFile('public/poie-icon.png');
await sharp(source).ensureAlpha().resize(64, 64).png().toFile('public/favicon.png');
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    await sharp(source).ensureAlpha().resize(size * scale, size * scale).png().toFile(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`));
  }
}
execFileSync('/usr/bin/iconutil', ['-c', 'icns', '-o', 'desktop/assets/icon.icns', iconset]);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(size => sharp(source).ensureAlpha().resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [index, size] of sizes.entries()) {
  const base = 6 + 16 * index;
  header[base] = size === 256 ? 0 : size; header[base + 1] = header[base];
  header.writeUInt16LE(1, base + 4); header.writeUInt16LE(32, base + 6);
  header.writeUInt32LE(images[index].length, base + 8); header.writeUInt32LE(offset, base + 12);
  offset += images[index].length;
}
await writeFile('desktop/assets/icon.ico', Buffer.concat([header, ...images]));
await copyFile('desktop/assets/icon.ico', 'public/favicon.ico');
const meta = await sharp(source).metadata();
console.log(JSON.stringify({source: {width:meta.width,height:meta.height,hasAlpha:meta.hasAlpha},exported:['PNG 1024','ICNS 16–1024','ICO 16–256','web 256','favicon 64']}, null, 2));
