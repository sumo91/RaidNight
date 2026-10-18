/**
 * 统一后处理链(T17 美术管线)—— 风格一致性的机制化。
 *
 * 链路固定两步,任何来源(手绘字符画 / 素材包 / AI 补量)的网格
 * 都必须整链过一遍,不允许跳步:
 *   ① 量化:把板外颜色收敛到全局调色板最近色;
 *   ② 描边:不透明像素的外轮廓(四邻域含透明)统一压成描边色。
 * 两步都是纯函数、对同一输入严格幂等 —— 「跑两遍和跑一遍长一样」
 * 是管线可复现的前提,测试锚定这一点。
 */

import { type PixelGrid, blankGrid, isTransparent, pixelAt, setPixel } from './grid';
import { OUTLINE_KEY, PALETTE_RGB, RGBA_BY_KEY } from './palette';

/** RGB 加权欧氏距离(人眼对绿更敏感,权重沿用经典 2-4-3 近似)。 */
function colorDistance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

/** 最近调色板色(索引);调色板非空由 palette.ts 的常量表保证。 */
export function nearestPaletteIndex(rgb: readonly [number, number, number]): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < PALETTE_RGB.length; i += 1) {
    const distance = colorDistance(rgb, PALETTE_RGB[i]!);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

/** ① 量化:返回新网格,不透明像素全部收敛到板内色(已是板内色则原样)。 */
export function quantizeToPalette(grid: PixelGrid): PixelGrid {
  const out = blankGrid(grid.width, grid.height);
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const rgba = pixelAt(grid, x, y);
      if (rgba[3] === 0) {
        continue;
      }
      const index = nearestPaletteIndex([rgba[0], rgba[1], rgba[2]]);
      const snapped = PALETTE_RGB[index]!;
      setPixel(out, x, y, [snapped[0], snapped[1], snapped[2], rgba[3]]);
    }
  }
  return out;
}

/** ② 描边:不透明像素若四邻域任一为透明(或出界),压成统一描边色。 */
export function applyOutline(grid: PixelGrid): PixelGrid {
  const outline = RGBA_BY_KEY.get(OUTLINE_KEY)!;
  const out = blankGrid(grid.width, grid.height);
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const rgba = pixelAt(grid, x, y);
      if (rgba[3] === 0) {
        continue;
      }
      const touchesEmpty =
        x === 0 ||
        y === 0 ||
        x === grid.width - 1 ||
        y === grid.height - 1 ||
        isTransparent(grid, x - 1, y) ||
        isTransparent(grid, x + 1, y) ||
        isTransparent(grid, x, y - 1) ||
        isTransparent(grid, x, y + 1);
      setPixel(out, x, y, touchesEmpty ? outline : rgba);
    }
  }
  return out;
}

/** 整链后处理:量化 → 描边。管线内资产输出前的必经之路。 */
export function postProcess(grid: PixelGrid): PixelGrid {
  return applyOutline(quantizeToPalette(grid));
}

/** 校验:网格所有不透明像素都已是板内色(用于测试与外部素材验收)。 */
export function isWithinPalette(grid: PixelGrid): boolean {
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const rgba = pixelAt(grid, x, y);
      if (rgba[3] === 0) {
        continue;
      }
      const index = nearestPaletteIndex([rgba[0], rgba[1], rgba[2]]);
      const snapped = PALETTE_RGB[index]!;
      if (snapped[0] !== rgba[0] || snapped[1] !== rgba[1] || snapped[2] !== rgba[2]) {
        return false;
      }
    }
  }
  return true;
}
