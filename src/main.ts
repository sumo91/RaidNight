import { gameDay, gameWeek } from './sim/clock';
import type { SimEvent } from './sim/events';
import type { SimInput, StepOutput } from './sim/facade';
import type { GameState } from './sim/state';
import type { OfflineHarvestView } from './ui/app';
import { mountApp } from './ui/app';
import { DEV_SEED, SimRuntime } from './shell/runtime';
import { runUnderOwnership } from './shell/ownership';
import './ui/app.css';

/**
 * 装配层(全窗):创建模拟门面、挂载薄渲染层、把现实时间换算成游戏时间增量。
 * 现实时间只出现在装配层(ADR-0004:1 现实天 = 1 游戏周,无现实时间硬门);
 * T19 起滴答循环、持久化介质读写与离线补结算抽到 shell/runtime(与小组件
 * 装配入口 src/widget-main.ts 共享),本文件只保留全窗特有的装配决策:
 * 存档文件的导出/导入 UI 接线、清档重开,以及桌面壳内的属主仲裁挂接。
 *
 * 持久化语义不变:编码/解码/迁移是 sim 纯函数(sim/save.ts),介质读写
 * (localStorage、导出下载、导入上传)在装配层 —— 每次推进后自动落盘,
 * 重开应用时恢复,进度不丢;导出/导入共用同一版本化格式(ADR-0003)。
 * 离线结算(T9)按「现在 − 落盘时刻」补结算,与在线同速率、无上限、幂等。
 */

/** 现实时钟采样间隔(毫秒);与游戏内节奏无关,只影响 UI 帧率。 */
const TICK_INTERVAL_MS = 500;

const runtime = new SimRuntime(
  { seed: DEV_SEED, tickIntervalMs: TICK_INTERVAL_MS },
  {
    onOutput: (state, events) => app.render(state, events),
  },
);

/** 清档重开:清空存储并重载页面(UI 的「清档重开」按钮经此回调触发)。 */
function wipeSave(): void {
  runtime.wipeStorage();
  window.location.reload();
}

/** 导出存档文件:文件名只用游戏时间与公会名;封皮带导出时刻(导入时按其补离线)。 */
function exportSaveFile(state: GameState): void {
  const safeName = state.guild.name.replace(/[\\/:*?"<>|]/g, '_');
  const fileName = `wowidle-${safeName}-第${gameWeek(state.clockGameMinutes)}周第${gameDay(state.clockGameMinutes)}天.json`;
  const blob = new Blob([runtime.exportSave()], { type: 'application/json' });
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

const app = mountApp(document.getElementById('app')!, {
  dispatch: (input: SimInput): StepOutput => {
    const output = runtime.dispatch(input);
    app.render(output.state, output.events);
    return output;
  },
  wipeSave,
  exportSave: () => exportSaveFile(runtime.state),
  importSave: (text) => {
    // 解码 + 迁移 + 结构校验都在 sim;失败返回 false(UI 提示导入失败)
    const result = runtime.importSave(text);
    if (result === null) {
      return false;
    }
    app.clearFeed(); // 旧进度的滚动日志不属于新进度
    app.render(runtime.state, result.events);
    app.showOfflineHarvest(result.harvest);
    return true;
  },
  simulateOffline: (realMs) => {
    // 调试条:走与真实离线完全相同的补结算路径
    const result = runtime.simulateOffline(realMs);
    app.render(runtime.state, result.events);
    app.showOfflineHarvest(result.harvest);
  },
});

/**
 * 打开应用:渲染首帧并展示离线补结算结果。
 * 浏览器/PWA:属主恒为本页,即刻起表(与小组件工单之前的行为一致)。
 * 桌面壳:全窗角色按属主仲裁起停 —— 小组件常驻期间本页隐藏停表,
 * 点击小组件「进入全窗」后接管(补结算结果在此渲染)。
 */
runUnderOwnership('main', runtime, {
  onGained: (result: { events: readonly SimEvent[]; harvest: OfflineHarvestView | null }) => {
    app.render(runtime.state, result.events);
    app.showOfflineHarvest(result.harvest);
  },
  onLost: () => {
    /* 交还给小组件:本页隐藏,无需展示(壳已把窗口藏起) */
  },
});
