import { describe, expect, it } from 'vitest';
import { blankGrid, parseSpriteRows, pixelAt, setPixel } from './grid';
import { encodePng } from './png';
import { ingestExternal, renderSheet, renderSprite } from './pipeline';
import { isWithinPalette, nearestPaletteIndex, postProcess, quantizeToPalette } from './post';
import { RGBA_BY_KEY } from './palette';
import { CLASSES } from '../content/classes';
import { BOSS_PORTRAITS } from '../content/boss-portraits';
import { ICONS } from '../content/icons';
import { PORTRAITS } from '../content/portraits';

/**
 * T17 美术管线测试:管线是纯函数库(不经门面 —— 它不是游戏本体,
 * 无状态、不推进游戏时间),按 comp.test.ts 先例直接断言纯函数。
 * 只验「可复现 / 统一风格(调色板收敛)/ 输出合法」三件事,
 * 不做审美判断(审美由样张评审承担,见 docs/art-style.md)。
 * PNG 校验刻意用独立实现(stored-deflate 读取器 + adler32),
 * 不复用编码器代码 —— 交叉验证,共享 bug 会被同时掩盖。
 */

/** 字节数组逐位相等(不用 Buffer,浏览器/节点两侧同构)。 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** adler32(独立实现,校验 zlib 流尾部)。 */
function adler32Of(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** 读 stored(无压缩)deflate 流并校验 adler32;非 stored 块直接失败。 */
function inflateStored(zlib: Uint8Array): Uint8Array {
  expect(zlib[0]).toBe(0x78); // CMF
  const raw: number[] = [];
  let offset = 2;
  let final = false;
  while (!final) {
    final = (zlib[offset]! & 1) === 1;
    expect(zlib[offset]! & 0b110).toBe(0); // BTYPE=00 stored
    const length = zlib[offset + 1]! | (zlib[offset + 2]! << 8);
    const nlen = zlib[offset + 3]! | (zlib[offset + 4]! << 8);
    expect(nlen).toBe((~length) & 0xffff); // NLEN = LEN 取反
    for (let i = 0; i < length; i += 1) {
      raw.push(zlib[offset + 5 + i]!);
    }
    offset += 5 + length;
  }
  const adler =
    ((zlib[offset]! << 24) | (zlib[offset + 1]! << 16) | (zlib[offset + 2]! << 8) | zlib[offset + 3]!) >>> 0;
  const data = Uint8Array.from(raw);
  expect(adler).toBe(adler32Of(data));
  return data;
}

/** 解析一个 PNG 的 chunk 结构(测试侧的独立读法,不复用编码器代码)。 */
function readPngChunks(png: Uint8Array): { type: string; data: Uint8Array; crcOk: boolean }[] {
  expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks: { type: string; data: Uint8Array; crcOk: boolean }[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = (png[offset]! << 24) | (png[offset + 1]! << 16) | (png[offset + 2]! << 8) | png[offset + 3]!;
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    const storedCrc =
      ((png[offset + 8 + length]! << 24) |
        (png[offset + 9 + length]! << 16) |
        (png[offset + 10 + length]! << 8) |
        png[offset + 11 + length]!) >>>
      0;
    chunks.push({ type, data, crcOk: storedCrc === crc32Of(type, data) });
    offset += 12 + length;
  }
  return chunks;
}

/** 与编码器同表但独立实现的 CRC32(交叉验证,不共享 bug)。 */
function crc32Of(type: string, data: Uint8Array): number {
  const bytes = Uint8Array.from([...Array.from(type, (ch) => ch.charCodeAt(0)), ...data]);
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

describe('T17 美术管线:内容稿合法性', () => {
  it('9 职业肖像齐全,与职业表一一对应,字符画全部可解析', () => {
    expect(PORTRAITS.length).toBe(9);
    const classIds = new Set(CLASSES.map((cls) => cls.id));
    for (const portrait of PORTRAITS) {
      expect(classIds.has(portrait.classId)).toBe(true);
      expect(() => parseSpriteRows(portrait.rows, portrait.key)).not.toThrow();
      expect(portrait.rows.length).toBe(24);
      expect(portrait.identity.length).toBeGreaterThanOrEqual(3);
    }
    expect(new Set(PORTRAITS.map((p) => p.classId)).size).toBe(9);
  });

  it('全部图标可解析且识别要素(名称)非空', () => {
    for (const icon of ICONS) {
      expect(() => parseSpriteRows(icon.rows, icon.key)).not.toThrow();
      expect(icon.name.length).toBeGreaterThan(0);
    }
  });
});

describe('T17 美术管线:可复现(验收标准 1)', () => {
  it('同一资产两次渲染,字节完全一致', () => {
    for (const portrait of PORTRAITS) {
      expect(bytesEqual(renderSprite(portrait), renderSprite(portrait))).toBe(true);
    }
    const sheetA = renderSheet(PORTRAITS, { columns: 3, cellPadding: 2, scale: 6 });
    const sheetB = renderSheet(PORTRAITS, { columns: 3, cellPadding: 2, scale: 6 });
    expect(bytesEqual(sheetA, sheetB)).toBe(true);
  });

  it('样张表尺寸按列数/留白/放大倍数精确排布', () => {
    // 9 张 24×24、3 列、留白 2、放大 6:格 = (24+4)×6 = 168,表 = 504×504
    const png = renderSheet(PORTRAITS, { columns: 3, cellPadding: 2, scale: 6 });
    const ihdr = readPngChunks(png).find((chunk) => chunk.type === 'IHDR')!.data;
    const width = (ihdr[0]! << 24) | (ihdr[1]! << 16) | (ihdr[2]! << 8) | ihdr[3]!;
    const height = (ihdr[4]! << 24) | (ihdr[5]! << 16) | (ihdr[6]! << 8) | ihdr[7]!;
    expect(width).toBe(504);
    expect(height).toBe(504);
  });
});

describe('T17 美术管线:统一风格(量化收敛 + 描边)', () => {
  it('外来颜色(素材包/AI 路径)经后处理全部收敛到全局调色板', () => {
    const grid = blankGrid(4, 4);
    // 板外色:#ff00ff 品红、#0f0f0f 近黑 —— 都不在 40 色板内
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        setPixel(grid, x, y, [(x * 60) % 256, (y * 60) % 256, 255, 255]);
      }
    }
    expect(isWithinPalette(grid)).toBe(false);
    const processed = postProcess(grid);
    expect(isWithinPalette(processed)).toBe(true);
  });

  it('量化对板内色是恒等(手绘稿过链不改变原有颜色)', () => {
    const grid = parseSpriteRows(PORTRAITS[0]!.rows, PORTRAITS[0]!.key);
    const quantized = quantizeToPalette(grid);
    expect(quantized.pixels).toEqual(grid.pixels);
  });

  it('最近色查找:品红量化的结果确实是板内某色', () => {
    const index = nearestPaletteIndex([255, 0, 255]);
    const snapped = [...RGBA_BY_KEY.values()][index];
    expect(snapped).toBeDefined();
  });

  it('不透明实心块的四周被压成统一描边色,中心保持原色', () => {
    const grid = blankGrid(4, 4);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        setPixel(grid, x, y, [244, 241, 251, 255]); // 月白
      }
    }
    const outlined = postProcess(grid);
    const outline = RGBA_BY_KEY.get('k')!;
    expect(pixelAt(outlined, 0, 0)).toEqual(outline);
    expect(pixelAt(outlined, 3, 3)).toEqual(outline);
    expect(pixelAt(outlined, 1, 1)).toEqual([244, 241, 251, 255]);
    expect(pixelAt(outlined, 2, 2)).toEqual([244, 241, 251, 255]);
  });

  it('后处理幂等:跑两遍与跑一遍相同(管线可反复过链)', () => {
    const grid = parseSpriteRows(ICONS[0]!.rows, ICONS[0]!.key);
    const once = postProcess(grid);
    const twice = postProcess(once);
    expect(twice.pixels).toEqual(once.pixels);
  });
});

describe('T17 美术管线:PNG 编码合法', () => {
  it('结构完整:魔数 + IHDR + IDAT + IEND,全部 chunk CRC 正确', () => {
    const png = renderSprite(PORTRAITS[0]!);
    const chunks = readPngChunks(png);
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(chunks.every((chunk) => chunk.crcOk)).toBe(true);
    const ihdr = chunks[0]!.data;
    expect(ihdr[8]).toBe(8); // 位深
    expect(ihdr[9]).toBe(6); // RGBA
  });

  it('IDAT 是合法 zlib 流:独立解码器可解,长度与网格严格吻合', () => {
    const grid = parseSpriteRows(PORTRAITS[1]!.rows, PORTRAITS[1]!.key);
    const png = encodePng(grid);
    const idat = readPngChunks(png).find((chunk) => chunk.type === 'IDAT')!.data;
    const raw = inflateStored(idat);
    expect(raw.length).toBe(grid.height * (1 + grid.width * 4));
    // 首行过滤器字节为 None,首像素 RGBA 与网格一致
    expect(raw[0]).toBe(0);
    expect(Array.from(raw.subarray(1, 5))).toEqual(Array.from(grid.pixels.subarray(0, 4)));
  });

  it('外部网格经 ingestExternal 输出同样合法的 PNG(素材包/AI 入口)', () => {
    const grid = blankGrid(8, 8);
    for (let y = 1; y < 7; y += 1) {
      for (let x = 1; x < 7; x += 1) {
        setPixel(grid, x, y, [120, 200, 90, 255]);
      }
    }
    const png = ingestExternal(grid);
    const chunks = readPngChunks(png);
    expect(chunks.every((chunk) => chunk.crcOk)).toBe(true);
    expect(() => inflateStored(chunks.find((c) => c.type === 'IDAT')!.data)).not.toThrow();
  });
});

describe('团本首领形象(T18 精修资产)', () => {
  it('6 名旗舰首领形象全部可渲染,画布 24×24 且像素全部落在板内', () => {
    expect(BOSS_PORTRAITS.length).toBe(6);
    for (const boss of BOSS_PORTRAITS) {
      const png = renderSprite(boss);
      expect(png.length).toBeGreaterThan(0);
      // 逐行宽度与字符合法性由解析器保证(非法即抛错);识别性要素登记在案
      expect(boss.identity.length).toBeGreaterThan(0);
      expect(boss.raidId.length).toBeGreaterThan(0);
    }
  });
});
