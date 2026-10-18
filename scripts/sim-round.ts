/**
 * 一轮节奏模拟脚本(T18 调参工具)。
 *
 * 用法:npm run sim:round [种子] [最大游戏周](vite-node 运行,零额外依赖)。
 * 打印贪心机器人从建会到通关最终团本的逐周时间线(等级/装等/金库/名册/团本夜),
 * 节奏粗调以此为据:目标带 = 第 6–8 游戏周通关。
 */

import { gameWeek } from '../src/sim/clock';
import { RoundBot } from './round-bot';

const seed = Number.parseInt(process.argv[2] ?? '20261018', 10) || 20261018;
const maxWeeks = Number.parseInt(process.argv[3] ?? '14', 10) || 14;

const started = Date.now();
const bot = new RoundBot(seed, '远征测试会');
const outcome = bot.play(maxWeeks);
const elapsed = Date.now() - started;

console.log(`[一轮模拟 seed=${seed} ${maxWeeks} 周上限 | ${elapsed}ms]`);
for (const s of outcome.snapshots) {
  console.log(
    `W${String(s.week).padStart(2)}: 等级${String(s.averageLevel).padStart(2)} 装等${String(s.averageItemLevel).padStart(2)} ` +
      `金库${String(s.vaultGold).padStart(4)} 名册${String(s.rosterSize).padStart(2)}` +
      (s.raidNight === undefined ? '' : ` | ${s.raidNight}`) +
      (s.clearedFinal ? ' | ★通关最终团本' : ''),
  );
}
console.log(
  `通关周:${outcome.finalClearWeek ?? '未通关(超时)'} · G团夜 ${outcome.gRunNights} 次 · 套装生效 ${outcome.setBonusMembers} 人 · 事件 ${outcome.eventCount} 条 · 时钟 ${gameWeek(outcome.state.clockGameMinutes)} 周`,
);
