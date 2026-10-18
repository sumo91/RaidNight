/**
 * 商店素材生成(T21):Steam 胶囊图 + 安卓启动图标 + TapTap 图标。
 *
 * 用法:npm run gen:store(零依赖,与 gen:icon 同链路)。
 * 全部从同一枚盾徽(scripts/lib/icon-grid.ts)派生,过同一量化色板,
 * 确定性重跑字节一致。产出:
 *   · store/steam/       —— 主胶囊 616×353、头部 460×215、小胶囊 231×87、
 *                           库竖版 600×900(标题字用 5×7 像素字体手绘)
 *   · store/taptap/      —— 商店图标 512×512
 *   · android/…/mipmap-* —— ic_launcher(legacy)/ic_launcher_round/
 *                           ic_launcher_foreground(自适应前景,安全区居中)
 *                           + values/ic_launcher_background.xml(玄墨底色)
 *
 * 说明:正式游戏名未定(DESIGN「未决项」,WowIdle 为工作名),胶囊标题
 * 用拉丁字「WowIdle」;定名后改本文件的 TITLE 常量重跑即可。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../src/art/png';
import { RGBA_BY_KEY } from '../src/art/palette';
import { blankGrid, blit, pixelAt, scaleNearest, setPixel, type PixelGrid } from '../src/art/grid';
import { buildAppIconGrid, ICON_SIZE } from './lib/icon-grid';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TITLE = 'WowIdle';

const INK = RGBA_BY_KEY.get('k')!; // 玄墨:胶囊底
const NIGHT = RGBA_BY_KEY.get('v')!; // 夜幕:底带 / 字影
const GOLD = RGBA_BY_KEY.get('y')!; // 鎏金:饰线
const BRIGHT = RGBA_BY_KEY.get('Y')!; // 亮金:标题字

/** 5×7 像素字体(只收标题用到的字形;定名换字时在此补画)。 */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  o: ['.....', '.###.', '#...#', '#...#', '#...#', '.###.', '.....'],
  w: ['.....', '.....', '#...#', '#...#', '#.#.#', '#.#.#', '.#.#.'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  d: ['....#', '....#', '.###.', '#...#', '#...#', '#...#', '.###.'],
  l: ['.##..', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  e: ['.....', '.###.', '#...#', '#####', '#....', '#...#', '.###.'],
};

/** 标题的像素块宽度(字 5 + 字距 1)。 */
function titleBlocks(text: string): number {
  return text.length * 6 - 1;
}

/** 把标题画到网格 (x, y)(单位:像素块 factor);先夜幕字影后亮金本体。 */
function drawTitle(grid: PixelGrid, text: string, x: number, y: number, factor: number): number {
  const width = titleBlocks(text) * factor;
  const put = (px: number, py: number, rgba: readonly [number, number, number, number]) => {
    for (let by = 0; by < factor; by += 1) {
      for (let bx = 0; bx < factor; bx += 1) {
        setPixel(grid, px + bx, py + by, rgba);
      }
    }
  };
  for (let pass = 0; pass < 2; pass += 1) {
    const offset = pass === 0 ? factor : 0; // 第一遍右下偏移一整块 = 字影
    const rgba = pass === 0 ? NIGHT : BRIGHT;
    let cursor = 0;
    for (const ch of text) {
      const glyph = GLYPHS[ch];
      if (glyph !== undefined) {
        glyph.forEach((row, gy) => {
          for (let gx = 0; gx < row.length; gx += 1) {
            if (row[gx] === '#') {
              put(x + (cursor + gx) * factor + offset, y + gy * factor + offset, rgba);
            }
          }
        });
      }
      cursor += 6;
    }
  }
  return width;
}

/** 填充矩形(纯色块)。 */
function fillRect(grid: PixelGrid, x: number, y: number, w: number, h: number, rgba: readonly [number, number, number, number]): void {
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      setPixel(grid, px, py, rgba);
    }
  }
}

/** 任意尺寸最近邻缩放(像素风;非整数倍时个别行列略窄,远观无感)。 */
function nearestResize(grid: PixelGrid, width: number, height: number): PixelGrid {
  const out = blankGrid(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      setPixel(out, x, y, pixelAt(grid, Math.floor((x * grid.width) / width), Math.floor((y * grid.height) / height)));
    }
  }
  return out;
}

/**
 * 圆形启动图标:玄墨圆盘 + 鎏金环 + 居中盾徽(round 版要让整圆被填满,
 * 直接裁剪方版会在圆的四边留下透明缺口)。
 */
function roundLauncher(size: number): PixelGrid {
  const grid = blankGrid(size, size);
  const r = size / 2;
  const ring = Math.max(2, Math.round(size / 48)); // 鎏金环宽(≈2~4px)
  const inner = r - ring;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x + 0.5 - r;
      const dy = y + 0.5 - r;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r) {
        setPixel(grid, x, y, d2 > inner * inner ? GOLD : INK);
      }
    }
  }
  const shieldSize = Math.round(size * 0.62);
  const shield = nearestResize(icon, shieldSize, shieldSize);
  blit(grid, shield, Math.floor((size - shieldSize) / 2), Math.floor((size - shieldSize) / 2));
  return grid;
}

const icon = buildAppIconGrid();

function write(fileName: string, bytes: Uint8Array): void {
  writeFileSync(fileName, bytes);
  console.log(`✓ ${fileName.replace(`${repoRoot}/`, '')}(${bytes.length} 字节)`);
}

// ———— Steam 胶囊图(横版:盾徽 + 标题;竖版:居中构图)————

function capsuleLandscape(width: number, height: number, shieldFactor: number, textFactor: number): Uint8Array {
  const grid = blankGrid(width, height);
  fillRect(grid, 0, 0, width, height, INK);
  // 底部夜幕带 + 鎏金饰线:给纯色底一点层次(放置游戏的暗色沉稳)
  const bandTop = Math.floor(height * 0.82);
  fillRect(grid, 0, bandTop, width, height - bandTop, NIGHT);
  fillRect(grid, 0, bandTop, width, Math.max(2, Math.floor(textFactor / 2)), GOLD);

  const shield = scaleNearest(icon, shieldFactor);
  const shieldY = Math.floor((bandTop - shield.height) / 2);
  blit(grid, shield, Math.floor(shieldFactor * 6), shieldY);

  const textY = Math.floor((bandTop - 7 * textFactor) / 2);
  drawTitle(grid, TITLE, Math.floor(shieldFactor * 6) + shield.width + Math.floor(shieldFactor * 5), textY, textFactor);
  return encodePng(grid);
}

function capsulePortrait(width: number, height: number, shieldFactor: number, textFactor: number): Uint8Array {
  const grid = blankGrid(width, height);
  fillRect(grid, 0, 0, width, height, INK);
  const bandTop = Math.floor(height * 0.86);
  fillRect(grid, 0, bandTop, width, height - bandTop, NIGHT);

  const shield = scaleNearest(icon, shieldFactor);
  blit(grid, shield, Math.floor((width - shield.width) / 2), Math.floor(height * 0.16));
  const textWidth = titleBlocks(TITLE) * textFactor;
  drawTitle(grid, TITLE, Math.floor((width - textWidth) / 2), Math.floor(height * 0.62), textFactor);
  const barY = Math.floor(height * 0.62) + 7 * textFactor + textFactor * 2;
  fillRect(grid, Math.floor((width - textWidth) / 2), barY, textWidth, Math.max(3, textFactor), GOLD);
  return encodePng(grid);
}

const steamDir = resolve(repoRoot, 'store/steam');
mkdirSync(steamDir, { recursive: true });
write(resolve(steamDir, 'capsule-main-616x353.png'), capsuleLandscape(616, 353, 8, 6));
write(resolve(steamDir, 'capsule-header-460x215.png'), capsuleLandscape(460, 215, 5, 5));
write(resolve(steamDir, 'capsule-small-231x87.png'), capsuleLandscape(231, 87, 2, 2));
write(resolve(steamDir, 'library-600x900.png'), capsulePortrait(600, 900, 12, 7));

// ———— TapTap 商店图标(512,与桌面 icon.png 同源同字节内容)————

const taptapDir = resolve(repoRoot, 'store/taptap');
mkdirSync(taptapDir, { recursive: true });
write(resolve(taptapDir, 'icon-512.png'), encodePng(scaleNearest(icon, 512 / ICON_SIZE)));

// ———— 安卓启动图标(mipmap 各密度 + 自适应前景 + 背景色)————

/** 密度 → legacy/round 图标边长(48dp 基准)与自适应前景边长(108dp 画布)。 */
const DENSITIES: readonly { name: string; launcher: number; foreground: number }[] = [
  { name: 'mdpi', launcher: 48, foreground: 108 },
  { name: 'hdpi', launcher: 72, foreground: 162 },
  { name: 'xhdpi', launcher: 96, foreground: 216 },
  { name: 'xxhdpi', launcher: 144, foreground: 324 },
  { name: 'xxxhdpi', launcher: 192, foreground: 432 },
];

for (const density of DENSITIES) {
  const dir = resolve(repoRoot, `android/app/src/main/res/mipmap-${density.name}`);
  mkdirSync(dir, { recursive: true });
  write(resolve(dir, 'ic_launcher.png'), encodePng(nearestResize(icon, density.launcher, density.launcher)));
  write(resolve(dir, 'ic_launcher_round.png'), encodePng(roundLauncher(density.launcher)));
  // 自适应前景:盾徽只占中央安全区(108dp 画布的中央 66dp,约 0.55)
  const fg = blankGrid(density.foreground, density.foreground);
  const shieldSize = Math.round(density.foreground * 0.55);
  const shield = nearestResize(icon, shieldSize, shieldSize);
  blit(fg, shield, Math.floor((density.foreground - shieldSize) / 2), Math.floor((density.foreground - shieldSize) / 2));
  write(resolve(dir, 'ic_launcher_foreground.png'), encodePng(fg));
}

// 自适应图标的背景色:玄墨(与盾徽底同色,系统裁形后四周不突兀)
writeFileSync(
  resolve(repoRoot, 'android/app/src/main/res/values/ic_launcher_background.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#171226</color>\n</resources>\n',
);
console.log('✓ android/…/values/ic_launcher_background.xml(#171226)');

console.log('完成:store/(Steam 胶囊 + TapTap 图标)与安卓 mipmap 全密度');
