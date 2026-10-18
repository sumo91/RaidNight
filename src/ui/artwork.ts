/**
 * UI 侧像素资产出口(T17 美术管线)。
 *
 * 薄渲染层的资产通道:把管线的 PNG 字节转成 data URL 并按资产 id
 * 缓存(同一资产只编码一次)。这里没有任何业务规则,也不生成/
 * 变换游戏数据 —— 只是把「内容表里的字符画 → 可显示的图」这一步
 * 摆到 UI 门口。所有 <img> 统一挂 .pixel-art(image-rendering:
 * pixelated),像素资产的呈现规矩只有这一处。
 */

import { renderSprite } from '../art/pipeline';
import { BOSS_PORTRAIT_BY_RAID } from '../content/boss-portraits';
import { ICON_BY_ID, type IconId } from '../content/icons';
import { PORTRAIT_BY_CLASS } from '../content/portraits';

/** 资产缓存:资产 key → data URL(模块级,进程内单例)。 */
const dataUrlCache = new Map<string, string>();

/** PNG 字节 → data URL(base64)。 */
function toDataUrl(bytes: Uint8Array): string {
  let binary = '';
  // 分段拼接避免 String.fromCharCode 展开大数组爆栈(资产都很小,稳妥起见仍分段)
  const CHUNK = 0x1000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:image/png;base64,${window.btoa(binary)}`;
}

function cachedDataUrl(key: string, render: () => Uint8Array): string {
  let url = dataUrlCache.get(key);
  if (url === undefined) {
    url = toDataUrl(render());
    dataUrlCache.set(key, url);
  }
  return url;
}

/** 职业肖像 data URL;未知职业回退占位稿(灰影剪影)。 */
export function portraitDataUrl(classId: string): string {
  const def = PORTRAIT_BY_CLASS.get(classId);
  if (def !== undefined) {
    return cachedDataUrl(def.key, () => renderSprite(def));
  }
  return cachedDataUrl('portrait-unknown', () => renderSprite(PORTRAIT_UNKNOWN));
}

/** 图标 data URL;未知图标回退 1×1 透明。 */
export function iconDataUrl(id: IconId): string {
  const def = ICON_BY_ID.get(id);
  if (def !== undefined) {
    return cachedDataUrl(def.key, () => renderSprite(def));
  }
  return cachedDataUrl('icon-unknown', () => renderSprite(ICON_UNKNOWN));
}

/** 团本首领形象 data URL(同团本共用旗舰首领形象);未登记回退灰影占位稿。 */
export function bossPortraitDataUrl(raidId: string): string {
  const def = BOSS_PORTRAIT_BY_RAID.get(raidId);
  if (def !== undefined) {
    return cachedDataUrl(def.key, () => renderSprite(def));
  }
  return cachedDataUrl('portrait-unknown', () => renderSprite(PORTRAIT_UNKNOWN));
}

/** 统一像素 <img> 构造:alt 必填(可访问性),尺寸由 CSS 决定。 */
export function pixelImg(url: string, alt: string, className = 'pixel-art'): HTMLImageElement {
  const img = document.createElement('img');
  img.src = url;
  img.alt = alt;
  img.className = className;
  img.decoding = 'async';
  img.draggable = false;
  return img;
}

/** 未知职业占位稿:灰影剪影(与 9 职业同骨架,保证缺数据时不破相)。 */
const PORTRAIT_UNKNOWN = {
  key: 'portrait-unknown',
  rows: [
    '........................',
    '.........kkkkkk.........',
    '........kggggggk........',
    '.......kggggggggk.......',
    '.......kgkkggkkgk.......',
    '.......kggggggggk.......',
    '........kggggggk........',
    '.........kkkkkk.........',
    '........kkkkkkkk........',
    '.....kkkkgggggkkkk......',
    '....kgggkgggggkgggk.....',
    '...kggggkgggggkggggk....',
    '...kggggkgggggkggggk....',
    '...kggggkgggggkggggk....',
    '...kggggkgggggkggggk....',
    '....kkkkgggggggkkkk.....',
    '......kgggggggggk.......',
    '......kgggggggggk.......',
    '......kgggggggggk.......',
    '......kgggggggggk.......',
    '.......kgggggggk........',
    '........kkkkkkk.........',
    '........................',
    '........................',
  ],
} as const;

/** 未知图标回退:1×1 透明。 */
const ICON_UNKNOWN = { key: 'icon-unknown', rows: ['.'] } as const;
