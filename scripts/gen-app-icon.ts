/**
 * 桌面壳应用图标生成(T19)。
 *
 * 用法:npm run gen:icon(vite-node 运行,零额外依赖)。
 * 产出(src-tauri/icons/):
 *   · icon.png(512)—— 精修基准与 Tauri icon 命令的种子图
 *   · 32x32.png / 128x128.png —— tauri.conf.json bundle.icon 引用
 *   · icon.icns —— macOS 应用图标(ic07/ic08/ic09/ic10 各嵌 PNG)
 *   · icon.ico —— Windows 图标(PNG 条目,Vista+ 支持;T21 验证打包)
 * 图形走 T17 美术管线同一链路(字符画 → 量化 + 描边 → PNG),
 * 确定性强:任何时候重跑,字节完全一致。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../src/art/png';
import { postProcess } from '../src/art/post';
import { parseSpriteRows, scaleNearest } from '../src/art/grid';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(repoRoot, 'src-tauri/icons');

// ———— 图形:32×32 字符画,公会盾徽(暗紫外底 + 鎏金盾 + 绯红宝珠)————

const SIZE = 32;

/** 圆角方形画布(透明外角,近似 macOS 图标的 squircle)。 */
function backgroundInside(x: number, y: number): boolean {
  const min = 4;
  const max = 27;
  if (x < min || x > max || y < min || y > max) {
    return false;
  }
  const corners = [
    (x - min) + (y - min),
    (max - x) + (y - min),
    (x - min) + (max - y),
    (max - x) + (max - y),
  ];
  return corners.every((sum) => sum >= 4);
}

/** 盾形:上半矩形、下半收尖;返回该点是否在盾内。 */
function shieldInside(x: number, y: number): boolean {
  const cx = 15.5;
  const top = 6;
  const bottom = 26;
  if (y < top || y > bottom) {
    return false;
  }
  const halfWidth = y <= 19 ? 7.5 : Math.max(1.5, 7.5 - (y - 19) * 1.5);
  return Math.abs(x - cx) <= halfWidth;
}

function buildIconRows(): string[] {
  const rows: string[] = [];
  for (let y = 0; y < SIZE; y += 1) {
    let row = '';
    for (let x = 0; x < SIZE; x += 1) {
      if (!backgroundInside(x, y)) {
        row += '.';
        continue;
      }
      if (shieldInside(x, y)) {
        const border =
          !shieldInside(x - 1, y) ||
          !shieldInside(x + 1, y) ||
          !shieldInside(x, y - 1) ||
          !shieldInside(x, y + 1);
        if (border) {
          row += 'y'; // 鎏金盾边
          continue;
        }
        // 中央宝珠:菱形绯红 + 亮金衬
        const dx = Math.abs(x - 15.5);
        const dy = Math.abs(y - 15.5);
        if (dx + dy < 2) {
          row += 'r';
        } else if (dx + dy < 4) {
          row += 'Y';
        } else {
          row += 'K'; // 岩灰盾面
        }
        continue;
      }
      row += 'k'; // 玄墨底
    }
    rows.push(row);
  }
  return rows;
}

const baseGrid = postProcess(parseSpriteRows(buildIconRows(), 'app-icon'));

/** 放大到目标尺寸并编码 PNG(最近邻,像素风)。 */
function pngAt(size: number): Uint8Array {
  const factor = Math.round(size / SIZE);
  if (factor < 1 || SIZE * factor !== size) {
    throw new Error(`尺寸 ${size} 不是 ${SIZE} 的整数倍`);
  }
  return encodePng(scaleNearest(baseGrid, factor));
}

// ———— 容器:ICNS 与 ICO 都是极简二进制拼装(零依赖,与 png.ts 同风格)————

function u32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function u16le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32le(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (ch) => ch.charCodeAt(0));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** ICNS:'icns' 总长 + 逐块(类型 + 块长 + PNG);类型对应 128/256/512/1024 槽。 */
function buildIcns(entries: readonly { type: string; png: Uint8Array }[]): Uint8Array {
  const chunks = entries.map((entry) =>
    concat([ascii(entry.type), u32be(entry.png.length + 8), entry.png]),
  );
  const body = concat(chunks);
  return concat([ascii('icns'), u32be(body.length + 8), body]);
}

/** ICO(PNG 条目):ICONDIR + ICONDIRENTRY×n + PNG 数据(Vista+ 支持 PNG 压缩条目)。 */
function buildIco(entries: readonly { size: number; png: Uint8Array }[]): Uint8Array {
  const header = concat([u16le(0), u16le(1), u16le(entries.length)]);
  const dirEntrySize = 16;
  const dataOffset = 6 + dirEntrySize * entries.length;
  const directory: Uint8Array[] = [];
  let offset = dataOffset;
  entries.forEach((entry) => {
    const dimension = entry.size >= 256 ? 0 : entry.size; // 0 = 256
    directory.push(
      concat([
        new Uint8Array([dimension, dimension, 0, 0]),
        u16le(1),
        u16le(32),
        u32le(entry.png.length),
        u32le(offset),
      ]),
    );
    offset += entry.png.length;
  });
  return concat([header, ...directory, ...entries.map((entry) => entry.png)]);
}

// ———— 产出 ————

mkdirSync(outDir, { recursive: true });

function write(fileName: string, bytes: Uint8Array): void {
  writeFileSync(resolve(outDir, fileName), bytes);
  console.log(`✓ ${fileName}(${bytes.length} 字节)`);
}

const png128 = pngAt(128);
const png256 = pngAt(256);
const png512 = pngAt(512);

write('32x32.png', pngAt(32));
write('128x128.png', png128);
write('icon.png', png512);
write('icon.icns', buildIcns([
  { type: 'ic07', png: png128 },
  { type: 'ic08', png: png256 },
  { type: 'ic09', png: png512 },
  { type: 'ic10', png: png512 },
]));
write('icon.ico', buildIco([
  { size: 32, png: pngAt(32) },
  { size: 128, png: png128 },
  { size: 256, png: png256 },
]));

console.log('完成:src-tauri/icons/(盾徽底图 32×32,已过量化 + 描边链)');
