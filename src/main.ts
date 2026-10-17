import { GAME_MINUTES_PER_REAL_MS, realMsToGameMinutes } from './sim/clock';
import { SimulationFacade } from './sim/facade';
import type { GameState } from './sim/state';
import { mountApp } from './ui/app';
import './ui/app.css';

/**
 * 装配层:创建模拟门面、挂载薄渲染层、把现实时间换算成游戏时间增量。
 * 这是全项目唯一允许出现「现实时间」的地方(ADR-0004:1 现实天 = 1 游戏周,无现实时间硬门)。
 * 持久化也只在这里:GameState 可序列化(ADR-0003 格式自第一版起版本化),
 * 每次推进后写入本地存储,重开应用时恢复 —— 编成等一切门面状态不丢。
 */

/** 开发期固定种子;无存档时用于建会。 */
const SEED = 20261018;
/** 存档键与格式版本(ADR-0003:格式版本化,升版走迁移)。 */
const SAVE_KEY = 'wowidle.save';
const SAVE_VERSION = 1;
/** 现实时钟采样间隔(毫秒);与游戏内节奏无关,只影响 UI 帧率。 */
const TICK_INTERVAL_MS = 500;

/** 版本化存档封皮。 */
interface SaveFile {
  readonly version: number;
  readonly state: GameState;
}

/** 读取存档:缺失、损坏或结构不完整一律返回 null(回退新档,不中断游戏)。 */
function loadSave(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const file = parsed as { version?: unknown; state?: unknown };
    if (file.version !== SAVE_VERSION || typeof file.state !== 'object' || file.state === null) {
      return null;
    }
    const state = file.state as GameState;
    // 结构防御:关键字段缺失视为损坏(重开不丢依赖这些字段的完整性)
    if (
      !Array.isArray(state.members) ||
      !Array.isArray(state.squads) ||
      !Array.isArray(state.applicants) ||
      typeof state.nextMemberId !== 'number' ||
      typeof state.nextSquadId !== 'number' ||
      typeof state.clockGameMinutes !== 'number' ||
      typeof state.rngState !== 'number'
    ) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

/** 写入存档:存储不可用(隐私模式等)时静默降级为本局内存态。 */
function persist(state: GameState): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_VERSION, state } satisfies SaveFile));
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

const saved = loadSave();
const facade = new SimulationFacade(SEED, undefined, saved ?? undefined);

const app = mountApp(document.getElementById('app')!, {
  dispatch: (input) => {
    const output = facade.dispatch(input);
    persist(output.state);
    app.render(output.state, output.events);
  },
  wipeSave,
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
