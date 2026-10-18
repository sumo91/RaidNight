/**
 * 小组件装配入口(T19,GLOSSARY:小组件模式)。
 *
 * 与 src/main.ts(全窗装配)对偶的第二装配层:同样只做三件事 ——
 * 创建共享运行时(现实时间 → 游戏时间增量的换算在 shell/runtime)、
 * 挂载薄渲染层、接桌面壳(Tauri 桥)。属主仲裁(shell/ownership)决定
 * 本页运行时的起停:全窗打开期间停表,收回后照存档时间戳补结算续走。
 *
 * 浏览器开发回退:无 Tauri 时小组件按标签页可见性运行;点击卡片
 * 打开主页(新标签)。真实形态(无边框置顶/贴角/记忆)走桌面壳,
 * 见 src-tauri/(需 Rust 工具链,npm run tauri dev)。
 */

import { DEV_SEED, SimRuntime } from './shell/runtime';
import { runUnderOwnership } from './shell/ownership';
import { initWidgetWindowControls } from './shell/widget-window';
import { openMainWindow, tauriAvailable } from './shell/tauri';
import { mountWidget } from './ui/widget';
import './ui/widget.css';

// 小组件的滴答比全窗慢一档:常驻形态看重「够新 + 省电」,
// 游戏分钟粒度的倒计时(≈8.6 现实秒)在 1 秒采样下无损
const WIDGET_TICK_MS = 1000;

const runtime = new SimRuntime(
  { seed: DEV_SEED, tickIntervalMs: WIDGET_TICK_MS },
  {
    onOutput: (state) => ui.render(state),
  },
);

const ui = mountWidget(document.getElementById('widget')!, {
  openFullWindow: () => {
    if (tauriAvailable()) {
      void openMainWindow(); // 桌面壳:切属主 → 显示/建全窗 → 聚焦
    } else {
      window.open('./', '_blank'); // 浏览器开发:全窗即主页
    }
  },
});

// 窗口形态接线(仅桌面壳内生效):恢复记忆位形、拖拽贴角、抓柄调大小
initWidgetWindowControls();

// 属主仲裁:小组件角色 —— 全窗打开期间 markDelegated(冻结提示),
// 收回后 start() 的补结算结果直接重渲染(小组件不演出离线摘要,全窗负责)
runUnderOwnership('widget', runtime, {
  onGained: () => ui.render(runtime.state),
  onLost: () => ui.markDelegated(),
});
