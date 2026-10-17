import { GAME_MINUTES_PER_REAL_MS, realMsToGameMinutes } from './sim/clock';
import { SimulationFacade } from './sim/facade';
import { mountApp } from './ui/app';
import './ui/app.css';

/**
 * 装配层:创建模拟门面、挂载薄渲染层、把现实时间换算成游戏时间增量。
 * 这是全项目唯一允许出现「现实时间」的地方(ADR-0004:1 现实天 = 1 游戏周,无现实时间硬门)。
 */

/** 开发期固定种子;正式版改为从本地版本化存档读取(ADR-0003)。 */
const SEED = 20261018;
/** 现实时钟采样间隔(毫秒);与游戏内节奏无关,只影响 UI 帧率。 */
const TICK_INTERVAL_MS = 500;

const facade = new SimulationFacade(SEED);

const app = mountApp(document.getElementById('app')!, {
  dispatch: (input) => {
    const output = facade.dispatch(input);
    app.render(output.state, output.events);
  },
});
app.render(facade.state, []);

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
  app.render(output.state, output.events);
}, TICK_INTERVAL_MS);
