/**
 * 存档双介质同步的纯决策核心(T21,ADR-0003「存档为本地文件」)。
 *
 * 桌面端存档同时存在于两处:
 * · localStorage —— 同步读写,起表即用的热副本(WKWebView 有强退丢尾风险);
 * · 本地文件(壳侧原子写,shell/tauri.ts 的文件桥)—— 权威副本,
 *   也是 Steam Auto-Cloud 的同步面。
 *
 * 本模块只做一件事:冷启动时给定两份原始存档文本,决定恢复哪份
 * (写回 localStorage,让 runtime.start() 走既有路径)。纯函数、
 * 解码复用 sim/save.ts,不接触任何介质 —— 与 widget-geometry 同级
 * 的可直测装配层纯模块。
 */

import { decodeSaveEnvelope } from '../sim/save';

/**
 * 选出冷启动恢复源。
 *
 * 规则:
 * · 文件档缺失或损坏 → 不恢复(null;localStorage(或新档)照旧);
 * · 本机 localStorage 档缺失或损坏 → 文件是救命稻草,恢复文件;
 * · 两份都完好 → 取封皮 savedAtMs(落盘时刻)新者;同刻或文件更旧
 *   → 不恢复(localStorage 已是最新)。savedAtMs 缺省(0)的旧档
 *   视为最旧,带时间基准的一方胜出。
 *
 * @param localRaw localStorage 里的原始存档文本(可能为 null)
 * @param diskRaw  桌面存档文件的原始文本(可能为 null)
 * @returns 应写入 localStorage 的存档文本;无需恢复返回 null
 */
export function pickRestoreSource(localRaw: string | null, diskRaw: string | null): string | null {
  if (diskRaw === null) {
    return null;
  }
  const disk = decodeSaveEnvelope(diskRaw);
  if (disk === null) {
    return null; // 文件损坏(比如磁盘上的半个 JSON):不当恢复源
  }
  if (localRaw === null) {
    return diskRaw;
  }
  const local = decodeSaveEnvelope(localRaw);
  if (local === null) {
    return diskRaw; // 本机热副本损坏:文件档救回进度
  }
  return disk.savedAtMs > local.savedAtMs ? diskRaw : null;
}
