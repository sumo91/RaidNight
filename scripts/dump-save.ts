/**
 * 演示存档导出(T21 商店截图用):用贪心机器人真实玩 N 周,
 * 把当时的存档写成可注入 localStorage 的文本文件。
 *
 * 用法:npm run sim:dump -- [周数] [输出路径] [种子]
 * 封皮 savedAtMs 取 0(无时间基准)—— 注入页面后不做离线补结算,
 * 截图呈现的就是导出那一刻的公会状态,确定、可复现。
 */

import { writeFileSync } from 'node:fs';
import { RoundBot } from './round-bot';
import { encodeSave } from '../src/sim/save';

const weeks = Number.parseInt(process.argv[2] ?? '5', 10) || 5;
const out = process.argv[3] ?? `/tmp/wowidle-demo-w${weeks}.json`;
const seed = Number.parseInt(process.argv[4] ?? '20261018', 10) || 20261018;

const bot = new RoundBot(seed, '晨风远征会');
const outcome = bot.play(weeks);
writeFileSync(out, encodeSave(outcome.state, 0));
console.log(
  `✓ ${out}:第 ${weeks} 周 · 名册 ${outcome.state.members.length} 人 · 小队 ${outcome.state.squads.length} 支 · 时钟 ${outcome.state.clockGameMinutes} 游戏分`,
);
