/**
 * 应用盾徽的字符画源(T19 引入,gen-app-icon.ts 与 gen-store-art.ts 共享)。
 *
 * 32×32:暗紫圆角底 + 鎏金盾 + 绯红宝珠。图形只在此定义一次,
 * 图标(src-tauri/icons)与商店素材(store/)都从它派生,
 * 保证桌面图标、安卓启动图标、商店胶囊图是同一枚盾徽。
 */

import { postProcess } from '../../src/art/post';
import { parseSpriteRows, type PixelGrid } from '../../src/art/grid';

/** 盾徽字符画的边长(正方形)。 */
export const ICON_SIZE = 32;

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
  for (let y = 0; y < ICON_SIZE; y += 1) {
    let row = '';
    for (let x = 0; x < ICON_SIZE; x += 1) {
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

/** 盾徽网格(已过统一后处理链:量化 + 描边)。 */
export function buildAppIconGrid(): PixelGrid {
  return postProcess(parseSpriteRows(buildIconRows(), 'app-icon'));
}
