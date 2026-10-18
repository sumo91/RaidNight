/**
 * 样张生成脚本(T17 美术管线)。
 *
 * 用法:npm run gen:art(vite-node 运行,零额外依赖)。
 * 产出(docs/art/samples/):
 *   · classes.png —— 9 职业识别性样张(3×3,评审与精修基准)
 *   · icons.png  —— 图标总览(职能 / 徽记 / 品质宝石)
 *   · MANIFEST.json —— 每个资产的 sha256 与字节数,供复现校验
 * 管线是纯函数:任何时候重跑,字节应与 MANIFEST 一致(除非内容稿改了)。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSheet, renderSprite } from '../src/art/pipeline';
import { ICONS } from '../src/content/icons';
import { PORTRAITS } from '../src/content/portraits';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(repoRoot, 'docs/art/samples');

/** 单资产清单条目。 */
interface ManifestEntry {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

function writeAsset(fileName: string, png: Uint8Array, manifest: ManifestEntry[]): void {
  writeFileSync(resolve(outDir, fileName), png);
  manifest.push({
    file: fileName,
    bytes: png.length,
    sha256: createHash('sha256').update(png).digest('hex'),
  });
  console.log(`✓ ${fileName}(${png.length} 字节)`);
}

mkdirSync(outDir, { recursive: true });
const manifest: ManifestEntry[] = [];

// 9 职业识别性样张:3×3、每格留白 2、放大 6 倍(审看粒度)
writeAsset('classes.png', renderSheet(PORTRAITS, { columns: 3, cellPadding: 2, scale: 6 }), manifest);

// 图标总览:职能 3 + 徽记 2 + 宝石 4,一行 9 格、放大 8 倍
writeAsset('icons.png', renderSheet(ICONS, { columns: 9, cellPadding: 2, scale: 8 }), manifest);

// 逐资产原图(UI 实际使用的尺寸,便于逐张审)
for (const portrait of PORTRAITS) {
  writeAsset(`${portrait.classId}.png`, renderSprite(portrait), manifest);
}
for (const icon of ICONS) {
  writeAsset(`${icon.id}.png`, renderSprite(icon), manifest);
}

writeAsset(
  'MANIFEST.json',
  new TextEncoder().encode(`${JSON.stringify({ generatedBy: 'npm run gen:art', assets: manifest }, null, 2)}\n`),
  manifest,
);

console.log(`共 ${manifest.length} 个文件写入 ${outDir}`);
