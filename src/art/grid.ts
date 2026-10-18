/**
 * 像素网格 —— 管线的中间表示(T17 美术管线)。
 *
 * 一切资产在管线内都以 RGBA 网格流转:字符画(手绘)解析成网格,
 * 素材包/AI 图缩放后也转成网格;后处理(post.ts)只认网格,
 * 输出层(png.ts)也只认网格。网格上的操作全部是纯函数。
 */

import { RGBA_BY_KEY } from './palette';

/** RGBA 像素网格;pixels 按 (y * width + x) * 4 排列,行间无过滤字节。 */
export interface PixelGrid {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** 透明像素判定(α = 0)。 */
export function isTransparent(grid: PixelGrid, x: number, y: number): boolean {
  return grid.pixels[(y * grid.width + x) * 4 + 3] === 0;
}

/** 新建空白(全透明)网格。 */
export function blankGrid(width: number, height: number): PixelGrid {
  return { width, height, pixels: new Uint8Array(width * height * 4) };
}

/** 取单像素 RGBA(读视图;越界按透明处理)。 */
export function pixelAt(grid: PixelGrid, x: number, y: number): readonly [number, number, number, number] {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) {
    return [0, 0, 0, 0];
  }
  const base = (y * grid.width + x) * 4;
  return [grid.pixels[base]!, grid.pixels[base + 1]!, grid.pixels[base + 2]!, grid.pixels[base + 3]!];
}

/** 写单像素 RGBA。 */
export function setPixel(grid: PixelGrid, x: number, y: number, rgba: readonly [number, number, number, number]): void {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) {
    return;
  }
  const base = (y * grid.width + x) * 4;
  grid.pixels[base] = rgba[0];
  grid.pixels[base + 1] = rgba[1];
  grid.pixels[base + 2] = rgba[2];
  grid.pixels[base + 3] = rgba[3];
}

/**
 * 字符画解析:每行一个字符串,'.' 为透明,其余字符必须是调色板键。
 * 行宽不一致或出现未知字符时抛错 —— 手绘稿拼错在解析期就暴露,
 * 而不是生成出一张歪图。
 */
export function parseSpriteRows(rows: readonly string[], what: string): PixelGrid {
  if (rows.length === 0) {
    throw new Error(`字符画「${what}」是空的`);
  }
  const width = rows[0]!.length;
  const grid = blankGrid(width, rows.length);
  rows.forEach((row, y) => {
    if (row.length !== width) {
      throw new Error(`字符画「${what}」第 ${y} 行宽 ${row.length},应为 ${width}`);
    }
    for (let x = 0; x < width; x += 1) {
      const ch = row[x]!;
      if (ch === '.') {
        continue;
      }
      const rgba = RGBA_BY_KEY.get(ch);
      if (rgba === undefined) {
        throw new Error(`字符画「${what}」(${x},${y})出现未知字符「${ch}」`);
      }
      setPixel(grid, x, y, rgba);
    }
  });
  return grid;
}

/** 把 src 网格原样贴到 dst 的 (x, y)(越界部分裁掉;dst 会被原地修改,仅在管线内部使用)。 */
export function blit(dst: PixelGrid, src: PixelGrid, x: number, y: number): void {
  for (let sy = 0; sy < src.height; sy += 1) {
    for (let sx = 0; sx < src.width; sx += 1) {
      const rgba = pixelAt(src, sx, sy);
      if (rgba[3] > 0) {
        setPixel(dst, sx + x, sy + y, rgba);
      }
    }
  }
}

/** 最近邻整数倍放大(像素风放大不插值)。 */
export function scaleNearest(grid: PixelGrid, factor: number): PixelGrid {
  if (factor <= 0 || !Number.isInteger(factor)) {
    throw new Error(`放大倍数必须是正整数,收到 ${factor}`);
  }
  const scaled = blankGrid(grid.width * factor, grid.height * factor);
  for (let y = 0; y < scaled.height; y += 1) {
    for (let x = 0; x < scaled.width; x += 1) {
      setPixel(scaled, x, y, pixelAt(grid, Math.floor(x / factor), Math.floor(y / factor)));
    }
  }
  return scaled;
}

/** 四周加透明边距(样张格子之间留白用)。 */
export function padGrid(grid: PixelGrid, margin: number): PixelGrid {
  const padded = blankGrid(grid.width + margin * 2, grid.height + margin * 2);
  blit(padded, grid, margin, margin);
  return padded;
}
