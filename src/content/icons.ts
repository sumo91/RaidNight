/**
 * 像素图标(手绘字符画,T17 美术管线的「批量图标」侧)。
 *
 * 三类:职能图标(编成页/结果卡阵容行)、结果卡徽记(胜/败卡面)、
 * 装备品质宝石(结果卡掉落行)。职能图标画布 12×12、徽记 16×16、
 * 宝石 8×8 —— 尺寸规范见 docs/art-style.md;字符 = 调色板键。
 */

import type { SpriteDef } from '../art/pipeline';

export type IconId =
  | 'role-tank'
  | 'role-heal'
  | 'role-dps'
  | 'emblem-win'
  | 'emblem-fail'
  | 'gem-white'
  | 'gem-green'
  | 'gem-blue'
  | 'gem-purple';

export interface IconDef extends SpriteDef {
  readonly id: IconId;
  /** 图标中文名(样张标注用)。 */
  readonly name: string;
}

export const ICONS: readonly IconDef[] = [
  {
    id: 'role-tank',
    key: 'icon-role-tank',
    name: '坦克(盾)',
    rows: [
      '...kkkkkk...',
      '..ksSSSSsk..',
      '..ksSrrSsk..',
      '..ksSrrSsk..',
      '..ksSSSSsk..',
      '...ksSSsk...',
      '...ksSSsk...',
      '....kssk....',
      '....kssk....',
      '.....kk.....',
      '............',
      '............',
    ],
  },
  {
    id: 'role-heal',
    key: 'icon-role-heal',
    name: '治疗(十字)',
    rows: [
      '............',
      '....kkkk....',
      '....kQQk....',
      '..kkkQQkkk..',
      '..kQQQQQQk..',
      '..kQQQQQQk..',
      '..kkkQQkkk..',
      '....kQQk....',
      '....kQQk....',
      '....kkkk....',
      '............',
      '............',
    ],
  },
  {
    id: 'role-dps',
    key: 'icon-role-dps',
    name: '输出(剑)',
    rows: [
      '............',
      '.....kS.....',
      '....kSSk....',
      '....kSSk....',
      '....kSSk....',
      '....kSSk....',
      '..kkkYYkkk..',
      '....kak.....',
      '....kak.....',
      '.....k......',
      '............',
      '............',
    ],
  },
  {
    id: 'emblem-win',
    key: 'icon-emblem-win',
    name: '告捷徽记(金杯)',
    rows: [
      '................',
      '....kkkkkkkk....',
      '...kYYYYYYYYk...',
      '...kYyyyyyyYk...',
      '..kkYyyyyyyYkk..',
      '.kYkYyyyyyyYkYk.',
      '.kYkkyyyyyykkYk.',
      '..k..kyyyyk..k..',
      '......kyyk......',
      '......kyyk......',
      '......kyyk......',
      '....kkyyyykk....',
      '...kyyyyyyyyk...',
      '....kkkkkkkk....',
      '................',
      '................',
    ],
  },
  {
    id: 'emblem-fail',
    key: 'icon-emblem-fail',
    name: '失利徽记(碎盾)',
    rows: [
      '................',
      '...kkkkkkkk.....',
      '..ksSSkSSSsk....',
      '..ksSk.kSSsk....',
      '..ks.kk.kSsk....',
      '..kk.ksk.kk.....',
      '..k.ksSsk.k.....',
      '....ksSSsk......',
      '....k.kSsk......',
      '.....kk.kk......',
      '......ksk.......',
      '.....ksSk.......',
      '......kk........',
      '................',
      '................',
      '................',
    ],
  },
  {
    id: 'gem-white',
    key: 'icon-gem-white',
    name: '白品质宝石',
    rows: [
      '...kk...',
      '..kwwk..',
      '.kwgwgk.',
      'kwgwwgwk',
      'kwgwwgwk',
      '.kwgwgk.',
      '..kwwk..',
      '...kk...',
    ],
  },
  {
    id: 'gem-green',
    key: 'icon-gem-green',
    name: '绿品质宝石',
    rows: [
      '...kk...',
      '..kGGk..',
      '.kGlGk..',
      'kGlGGlGk',
      'kGlGGlGk',
      '.kGlGk..',
      '..kGGk..',
      '...kk...',
    ],
  },
  {
    id: 'gem-blue',
    key: 'icon-gem-blue',
    name: '蓝品质宝石',
    rows: [
      '...kk...',
      '..kuuk..',
      '.kuUuk..',
      'kuUuuUuk',
      'kuUuuUuk',
      '.kuUuk..',
      '..kuuk..',
      '...kk...',
    ],
  },
  {
    id: 'gem-purple',
    key: 'icon-gem-purple',
    name: '紫品质宝石',
    rows: [
      '...kk...',
      '..kppk..',
      '.kpPpk..',
      'kpPppPpk',
      'kpPppPpk',
      '.kpPpk..',
      '..kppk..',
      '...kk...',
    ],
  },
];

/** 按图标 id 查定义(UI 换装用)。 */
export const ICON_BY_ID: ReadonlyMap<IconId, IconDef> = new Map(ICONS.map((icon) => [icon.id, icon]));
