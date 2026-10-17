import {
  GAME_MINUTES_PER_REAL_MS,
  GAME_MINUTES_PER_WEEK,
  gameDay,
  gameWeek,
  realMsToGameMinutes,
} from './sim/clock';
import { SimulationFacade, decodeSaveEnvelope, encodeSave } from './sim/facade';
import type { SimEvent } from './sim/events';
import type { GameState } from './sim/state';
import type { OfflineHarvestView } from './ui/app';
import { formatGameDuration, formatGameStamp, formatRealDuration } from './ui/format';
import { mountApp } from './ui/app';
import './ui/app.css';

/**
 * 装配层:创建模拟门面、挂载薄渲染层、把现实时间换算成游戏时间增量。
 * 这是全项目唯一允许出现「现实时间」的地方(ADR-0004:1 现实天 = 1 游戏周,无现实时间硬门)。
 * 持久化也只在这里:编码/解码/迁移是 sim 纯函数(sim/save.ts),
 * 介质读写(localStorage、导出下载、导入上传)在本层 —— 每次推进后自动落盘,
 * 重开应用时恢复,进度不丢;导出/导入共用同一版本化格式(ADR-0003)。
 *
 * 离线结算(T9):存档封皮携带落盘时刻(savedAtMs);打开应用时按
 * 「现在 − 落盘时刻」的现实时长换算出游戏时间增量,交门面分段补结算 ——
 * 与在线同速率、无上限、无惩罚(ADR-0003:基于时间戳推进、离线结算幂等)。
 */

/** 开发期固定种子;无存档时用于建会。 */
const SEED = 20261018;
/** 本机自动存档的存储键(格式与版本见 sim/save.ts)。 */
const SAVE_KEY = 'wowidle.save';
/** 现实时钟采样间隔(毫秒);与游戏内节奏无关,只影响 UI 帧率。 */
const TICK_INTERVAL_MS = 500;
/**
 * 离线补结算的分段上限:1 游戏周(= 1 现实天)一段。
 * 单段开销有界;分段不改结果 —— 门面对同一起止时间的任意切分严格等价
 * (sim/offline.test.ts:分段与整跳等价)。
 */
const OFFLINE_SEGMENT_GAME_MINUTES = GAME_MINUTES_PER_WEEK;

/** 读取本机存档:缺失、损坏或版本无法迁移一律返回 null(回退新档,不中断游戏)。 */
function loadSave(): { state: GameState; savedAtMs: number } | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw === null ? null : decodeSaveEnvelope(raw);
  } catch {
    return null;
  }
}

/** 写入本机存档(封皮带落盘时刻,离线结算的起测点);存储不可用时静默降级为本局内存态。 */
function persist(state: GameState): void {
  try {
    localStorage.setItem(SAVE_KEY, encodeSave(state, Date.now()));
  } catch {
    // 本局照常运行,只是不落盘
  }
}

/** 清档重开:清空存储并重载页面(UI 的「清档重开」按钮经此回调触发)。 */
function wipeSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // 清不掉也无妨:重载后会被覆盖写
  }
  window.location.reload();
}

/** 导出存档文件:文件名只用游戏时间与公会名;封皮带导出时刻(导入时按其补离线)。 */
function exportSaveFile(state: GameState): void {
  const safeName = state.guild.name.replace(/[\\/:*?"<>|]/g, '_');
  const fileName = `wowidle-${safeName}-第${gameWeek(state.clockGameMinutes)}周第${gameDay(state.clockGameMinutes)}天.json`;
  const blob = new Blob([encodeSave(state, Date.now())], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

const saved = loadSave();
const facade = new SimulationFacade(SEED, undefined, saved?.state);

const app = mountApp(document.getElementById('app')!, {
  dispatch: (input) => {
    const output = facade.dispatch(input);
    persist(output.state);
    app.render(output.state, output.events);
  },
  wipeSave,
  exportSave: () => exportSaveFile(facade.state),
  importSave: (text) => {
    // 解码 + 迁移 + 结构校验都在 sim;失败返回 false(UI 提示导入失败)
    const decoded = decodeSaveEnvelope(text);
    if (decoded === null) {
      return false;
    }
    facade.restore(decoded.state);
    // 导入的存档同样按其落盘时刻补离线(时间戳随文件走,离线结算幂等)
    const catchUp = settleOffline(decoded.savedAtMs > 0 ? Date.now() - decoded.savedAtMs : 0);
    persist(facade.state); // 立即落盘:导入即成本机最新进度
    app.clearFeed(); // 旧实例的滚动日志不属于新进度
    app.render(facade.state, catchUp.events);
    app.showOfflineHarvest(catchUp.harvest);
    return true;
  },
  simulateOffline: (realMs) => {
    // 调试条:走与真实离线完全相同的补结算路径
    const catchUp = settleOffline(realMs);
    persist(facade.state);
    app.render(facade.state, catchUp.events);
    app.showOfflineHarvest(catchUp.harvest);
  },
});

/**
 * 离线补结算:把一段离线现实时长换算为游戏分钟,分段派发并收割全部结果。
 * 入参是「离线了多久」(时长):冷开与导入按「现在 − 存档时间戳」计算,模拟离线直接给时长。
 * 返回补记事件与「离线归来」摘要(未跨过任何日界时摘要为 null —— 无事发生,不打扰)。
 */
function settleOffline(elapsedRealMs: number): { events: SimEvent[]; harvest: OfflineHarvestView | null } {
  if (elapsedRealMs <= 0) {
    return { events: [], harvest: null }; // 没有离线时长(新档/旧档无时间基准):不做补结算
  }
  const fromClock = facade.state.clockGameMinutes;
  const totalGameMinutes = Math.floor(realMsToGameMinutes(elapsedRealMs));

  // 分段派发:每段 ≤ 1 游戏周,段内由门面逐日结算;事件按发生顺序累计
  const events: SimEvent[] = [];
  let remaining = totalGameMinutes;
  while (remaining > 0) {
    const segment = Math.min(remaining, OFFLINE_SEGMENT_GAME_MINUTES);
    events.push(...facade.dispatch({ deltaGameMinutes: segment }).events);
    remaining -= segment;
  }
  if (events.length === 0) {
    return { events, harvest: null }; // 离线不足一个日界:时钟已推进,但没有可呈现的结果
  }

  // 离线归来摘要:统计全部在装配层完成,UI 只渲染
  const wins = events.filter((e) => e.kind === '下本' && e.text.includes('速通')).length;
  const losses = events.filter((e) => e.kind === '下本' && e.text.includes('败退')).length;
  const equipped = events.filter((e) => e.kind === '下本' && e.text.includes('换上')).length;
  const highlights: string[] = [];
  if (wins + losses > 0) {
    highlights.push(`下本速通 ${wins} 次、败退 ${losses} 次。`);
  }
  if (equipped > 0) {
    highlights.push(`缴获并换上 ${equipped} 件装备。`);
  }
  const harvest: OfflineHarvestView = {
    awayText: formatRealDuration(elapsedRealMs),
    advancedText: formatGameDuration(totalGameMinutes),
    fromStamp: formatGameStamp(fromClock),
    toStamp: formatGameStamp(facade.state.clockGameMinutes),
    eventCount: events.length,
    highlights,
  };
  return { events, harvest };
}

// 打开应用:先做离线补结算(一次性收割离线期间全部活动结果),再首次渲染
// (存档不带时间基准的旧档按 0 处理:不做补结算)
const openingCatchUp =
  saved !== null && saved.savedAtMs > 0
    ? settleOffline(Date.now() - saved.savedAtMs)
    : { events: [] as SimEvent[], harvest: null as OfflineHarvestView | null };
app.render(facade.state, openingCatchUp.events);
app.showOfflineHarvest(openingCatchUp.harvest);
persist(facade.state);

// 现实时间 → 游戏时间增量:增量取整并保留余数进位,保证确定性不受浮点影响
let lastRealMs = performance.now();
let carryMs = 0;

window.setInterval(() => {
  const now = performance.now();
  carryMs += now - lastRealMs;
  lastRealMs = now;
  const delta = Math.floor(realMsToGameMinutes(carryMs));
  if (delta <= 0) {
    return;
  }
  carryMs -= delta / GAME_MINUTES_PER_REAL_MS;
  const output = facade.dispatch({ deltaGameMinutes: delta });
  persist(output.state);
  app.render(output.state, output.events);
}, TICK_INTERVAL_MS);
