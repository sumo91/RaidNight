/**
 * 像素资产管线编排(T17 美术管线)。
 *
 * 资产的三条来源汇入同一出口:
 *   · 手绘/精修 —— 字符画(调色板键)定义,数据在 src/content/;
 *   · 素材包 —— 外部 RGBA 网格经 ingestExternal 并入;
 *   · AI 补量 —— 同上(AI 图先栅格化为 RGBA 网格,再走同一条链)。
 * 三条路都过 post.ts 的统一后处理(量化 + 描边),再由 png.ts 编码。
 * 全部纯函数:同一输入永远得到同一字节序列。
 */

import { blankGrid, blit, parseSpriteRows, padGrid, scaleNearest, type PixelGrid } from './grid';
import { postProcess } from './post';
import { encodePng } from './png';

/** 手绘字符画资产定义(调色板键行)。 */
export interface SpriteDef {
  readonly key: string;
  readonly rows: readonly string[];
}

/** 字符画 → PNG 字节(解析 → 统一后处理 → 编码)。 */
export function renderSprite(def: SpriteDef): Uint8Array {
  return encodePng(postProcess(parseSpriteRows(def.rows, def.key)));
}

/**
 * 外部网格(素材包 / AI)→ PNG 字节:与手绘同一后处理链。
 * 网格来自上游的栅格化(解码图片、缩放到目标画布),此处不猜来源。
 */
export function ingestExternal(grid: PixelGrid): Uint8Array {
  return encodePng(postProcess(grid));
}

/** 样张拼图选项。 */
export interface SheetOptions {
  /** 列数;行数按资产数向上取整。 */
  readonly columns: number;
  /** 每格四周透明留白(像素)。 */
  readonly cellPadding: number;
  /** 整数倍放大(样张审看用;1 = 原尺寸)。 */
  readonly scale: number;
}

/**
 * 样张表:等大格子网状排布资产(每格先统一到最大资产尺寸)。
 * 用于 9 职业识别性样张与图标总览;顺序即摆放顺序。
 */
export function renderSheet(defs: readonly SpriteDef[], options: SheetOptions): Uint8Array {
  if (defs.length === 0) {
    throw new Error('样张表不能为空');
  }
  if (options.columns <= 0) {
    throw new Error(`样张列数必须为正,收到 ${options.columns}`);
  }
  const grids = defs.map((def) => postProcess(parseSpriteRows(def.rows, def.key)));
  const cellW = Math.max(...grids.map((g) => g.width)) + options.cellPadding * 2;
  const cellH = Math.max(...grids.map((g) => g.height)) + options.cellPadding * 2;
  const rows = Math.ceil(defs.length / options.columns);
  const sheet = blankGrid(cellW * options.columns * options.scale, cellH * rows * options.scale);
  grids.forEach((grid, index) => {
    const column = index % options.columns;
    const row = Math.floor(index / options.columns);
    blit(
      sheet,
      scaleNearest(padGrid(grid, options.cellPadding), options.scale),
      column * cellW * options.scale,
      row * cellH * options.scale,
    );
  });
  return encodePng(sheet);
}
