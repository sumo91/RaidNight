/**
 * 全局像素调色板 —— 统一风格的锚点(T17 美术管线)。
 *
 * 管线的三个素材来源(手绘字符画 / 素材包 / AI 补量)最终都要并入
 * 这同一张色板:外来像素经量化(post.ts)收敛到板内色,任何资产
 * 不会出现板外颜色 —— 这是「统一后处理」里最根本的一步。
 * 改板 = 改全局风格:只允许增删条目,不要顺手改已有色的 hex
 * (存量资产与样张的审校基准都锚在 hex 上)。
 */

/** 单个调色板条目:字符键(字符画用)+ 色名 + hex。 */
export interface PaletteColor {
  /** 字符画中代表此色的单字符;'.' 固定为透明,不占条目。 */
  readonly key: string;
  /** 中文色名(样张与风格文档引用)。 */
  readonly name: string;
  /** #RRGGBB;透明不存在条目里。 */
  readonly hex: string;
}

/** 全局调色板:暗色奇幻、与 UI 深紫外壳同底色。 */
export const PALETTE: readonly PaletteColor[] = [
  { key: 'k', name: '玄墨', hex: '#171226' },
  { key: 'K', name: '岩灰', hex: '#3f3a58' },
  { key: 's', name: '钢青', hex: '#8d93b8' },
  { key: 'S', name: '霜银', hex: '#d9def2' },
  { key: 'w', name: '月白', hex: '#f4f1fb' },
  { key: 'g', name: '雾灰', hex: '#b6b0c6' },
  { key: 'e', name: '暗肤', hex: '#b9805e' },
  { key: 'f', name: '肤色', hex: '#eec49f' },
  { key: 'b', name: '焦棕', hex: '#7a4a2b' },
  { key: 'B', name: '鞍棕', hex: '#a8713f' },
  { key: 'n', name: '沙棕', hex: '#d9a56b' },
  { key: 'r', name: '殷红', hex: '#a93c3c' },
  { key: 'R', name: '绯红', hex: '#d96666' },
  { key: 'Q', name: '淡绯', hex: '#f2a3a3' },
  { key: 'y', name: '鎏金', hex: '#d4a017' },
  { key: 'Y', name: '亮金', hex: '#f5d76e' },
  { key: 'D', name: '幽林', hex: '#2e5230' },
  { key: 'G', name: '苔绿', hex: '#4a7c3f' },
  { key: 'l', name: '新叶', hex: '#79b75a' },
  { key: 'i', name: '深海', hex: '#2e5d8a' },
  { key: 'u', name: '潮蓝', hex: '#3f6fc4' },
  { key: 'U', name: '澜青', hex: '#7fa3e8' },
  { key: 'c', name: '晴空', hex: '#6fc7e8' },
  { key: 'C', name: '晨光', hex: '#aee6f7' },
  { key: 'x', name: '暗渊', hex: '#43256b' },
  { key: 'p', name: '幽紫', hex: '#6b3fa0' },
  { key: 'P', name: '虹紫', hex: '#a678d8' },
  { key: 'q', name: '暗玫', hex: '#a05a8a' },
  { key: 'o', name: '粉玫', hex: '#d88ac0' },
  { key: 'O', name: '樱粉', hex: '#f0c0dd' },
  { key: 'z', name: '焦橙', hex: '#8a4a1a' },
  { key: 't', name: '琥珀', hex: '#d07a2f' },
  { key: 'T', name: '明橙', hex: '#f0a860' },
  { key: 'm', name: '橄榄', hex: '#8a6f33' },
  { key: 'a', name: '沙金', hex: '#c9a95c' },
  { key: 'A', name: '亮沙', hex: '#e8d391' },
  { key: 'v', name: '夜幕', hex: '#241c36' },
  { key: 'V', name: '幕紫', hex: '#372c52' },
];

/** 统一描边色(后处理轮廓用;与 UI 描线同源)。 */
export const OUTLINE_KEY = 'k';

/** hex(#RRGGBB)→ RGBA 字节。 */
export function hexToRgba(hex: string): readonly [number, number, number, number] {
  const value = hex.startsWith('#') ? hex.slice(1) : hex;
  if (value.length !== 6) {
    throw new Error(`调色板 hex 非法:${hex}`);
  }
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return [r, g, b, 255];
}

/** 字符键 → RGBA(含透明哨兵 '.');未知键抛错,让字符画拼错在解析期就炸。 */
export const RGBA_BY_KEY: ReadonlyMap<string, readonly [number, number, number, number]> = new Map(
  PALETTE.map((color) => [color.key, hexToRgba(color.hex)]),
);

/** 板内 RGBA 色列表(量化目标集)。 */
export const PALETTE_RGB: readonly (readonly [number, number, number])[] = PALETTE.map((color) => {
  const [r, g, b] = hexToRgba(color.hex);
  return [r, g, b] as const;
});

/** 字符是否为字符画合法字符(板内键或透明 '.')。 */
export function isSpriteChar(ch: string): boolean {
  return ch === '.' || RGBA_BY_KEY.has(ch);
}
