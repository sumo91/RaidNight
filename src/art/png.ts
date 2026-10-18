/**
 * 零依赖 PNG 编码器(T17 美术管线)。
 *
 * 只写不读、只支持 8bit RGBA 真彩色,目标是让同一段编码代码
 * 在浏览器(UI 内联 data URL)与 node(样张落盘脚本)两侧完全一致
 * —— 字节级一致是「管线可复现」的硬保证。
 * zlib 流使用 stored(无压缩)deflate 块:像素量小,换来的是
 * 编码器可整体内联、无平台 zlib 行为差异。
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** CRC-32(IEEE 802.3 多项式,查表法;PNG chunk 校验用)。 */
const CRC_TABLE: readonly number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    // 查表索引必须掩到低 8 位:漏掩会让索引越表、CRC 全错
    // (node zlib 只校验 deflate 流不校验 chunk CRC,浏览器等严格解码器才会拒绝)
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Adler-32(zlib 流校验和)。 */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib 流:deflate stored 块 + adler32。块数据上限 65535 字节,超长自动分块。 */
function zlibStore(raw: Uint8Array): Uint8Array {
  const chunks: number[] = [0x78, 0x01]; // CMF/FLG:deflate、最小字典、校验通过
  let offset = 0;
  while (offset < raw.length || raw.length === 0) {
    const remaining = raw.length - offset;
    const length = Math.min(remaining, 65535);
    const isFinal = offset + length >= raw.length ? 1 : 0;
    chunks.push(isFinal); // BFINAL + BTYPE=00(stored)
    chunks.push(length & 0xff, (length >> 8) & 0xff); // LEN(小端)
    chunks.push(~length & 0xff, (~length >> 8) & 0xff); // NLEN(LEN 取反)
    for (let i = 0; i < length; i += 1) {
      chunks.push(raw[offset + i]!);
    }
    offset += length;
    if (raw.length === 0) {
      break; // 空数据也要出一个终块
    }
  }
  const adler = adler32(raw);
  chunks.push((adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff);
  return Uint8Array.from(chunks);
}

/** 字节块顺序拼接(避免大数组的展开运算符开销)。 */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** PNG chunk:长度(4BE)+ 类型 + 数据 + CRC32(类型+数据)。 */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(Array.from(type, (ch) => ch.charCodeAt(0)));
  const body = concatBytes([typeBytes, data]);
  const lengthBytes = Uint8Array.from([
    data.length >>> 24,
    (data.length >>> 16) & 0xff,
    (data.length >>> 8) & 0xff,
    data.length & 0xff,
  ]);
  const crc = crc32(body);
  const crcBytes = Uint8Array.from([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]);
  return concatBytes([lengthBytes, body, crcBytes]);
}

/** RGBA 网格 → PNG 字节(8bit 真彩色 + Alpha,行过滤器全 None)。 */
export function encodePng(grid: { width: number; height: number; pixels: Uint8Array }): Uint8Array {
  // 每行前加一个过滤器字节(0 = None)
  const raw = new Uint8Array(grid.height * (1 + grid.width * 4));
  for (let y = 0; y < grid.height; y += 1) {
    const rowStart = y * (1 + grid.width * 4);
    raw[rowStart] = 0;
    raw.set(
      grid.pixels.subarray(y * grid.width * 4, (y + 1) * grid.width * 4),
      rowStart + 1,
    );
  }

  const ihdr = new Uint8Array(13);
  const w = grid.width;
  const h = grid.height;
  ihdr.set([w >>> 24, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff], 0);
  ihdr.set([h >>> 24, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff], 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 位深 8、颜色类型 6(RGBA)、压缩 0、过滤 0、隔行 0

  return concatBytes([
    Uint8Array.from(PNG_SIGNATURE),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlibStore(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}
