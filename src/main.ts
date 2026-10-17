import { GAME_MINUTES_PER_REAL_MS, gameDay, gameWeek, realMsToGameMinutes } from './sim/clock';
import { SimulationFacade, decodeSave, encodeSave } from './sim/facade';
import type { GameState } from './sim/state';
import { mountApp } from './ui/app';
import './ui/app.css';

/**
 * 装配层:创建模拟门面、挂载薄渲染层、把现实时间换算成游戏时间增量。
 * 这是全项目唯一允许出现「现实时间」的地方(ADR-0004:1 现实天 = 1 游戏周,无现实时间硬门)。
 * 持久化也只在这里:编码/解码/迁移是 sim 纯函数(sim/save.ts),
 * 介质读写(localStorage、导出下载、导入上传)在本层 —— 每次推进后自动落盘,
 * 重开应用时恢复,进度不丢;导出/导入共用同一版本化格式(ADR-0003)。
 */

/** 开发期固定种子;无存档时用于建会。 */
const SEED = 20261018;
/** 本机自动存档的存储键(格式与版本见 sim/save.ts)。 */
const SAVE_KEY = 'wowidle.save';
/** 现实时钟采样间隔(毫秒);与游戏内节奏无关,只影响 UI 帧率。 */
const TICK_INTERVAL_MS = 500;

/** 读取本机存档:缺失、损坏或版本无法迁移一律返回 null(回退新档,不中断游戏)。 */
function loadSave(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw === null ? null : decodeSave(raw);
  } catch {
    return null;
  }
}

/** 写入本机存档:存储不可用(隐私模式等)时静默降级为本局内存态。 */
function persist(state: GameState): void {
  try {
    localStorage.setItem(SAVE_KEY, encodeSave(state));
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

/** 导出存档文件:文件名只用游戏时间与公会名(不引入现实时间)。 */
function exportSaveFile(state: GameState): void {
  const safeName = state.guild.name.replace(/[\\/:*?"<>|]/g, '_');
  const fileName = `wowidle-${safeName}-第${gameWeek(state.clockGameMinutes)}周第${gameDay(state.clockGameMinutes)}天.json`;
  const blob = new Blob([encodeSave(state)], { type: 'application/json' });
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
const facade = new SimulationFacade(SEED, undefined, saved ?? undefined);

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
    const state = decodeSave(text);
    if (state === null) {
      return false;
    }
    facade.restore(state);
    persist(state); // 立即落盘:导入即成本机最新进度
    app.clearFeed(); // 旧实例的滚动日志不属于新进度
    app.render(state, []);
    return true;
  },
});
app.render(facade.state, []);
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
