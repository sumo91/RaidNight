import { describe, expect, it } from 'vitest';
import { VAULT } from '../content/economy';
import { RECRUIT } from '../content/recruit';
import { RoundBot } from '../../scripts/round-bot';
import { SimulationFacade } from './facade';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK } from './clock';
import { WIDGET_RECENT_LIMIT, widgetView } from './widget';
import type { GameState } from './state';

/**
 * T19 门面测试:小组件派生量 —— 倒计时 / 最近结果与掉落 / 资源条。
 *
 * 只打门面接缝:给定种子与「指令 + 时间跳变」脚本,断言派生视图。
 * 派生模块(sim/widget.ts)是纯函数,数据来自状态与内容表,
 * 倒计时的取法与 sim/schedule 同式(自动层真正结算的时刻)。
 */

const SEED = 20261018;

describe('T19 小组件:建会初始的派生视图', () => {
  const facade = new SimulationFacade(SEED, '星盾测试会');

  it('倒计时:未开团 ⇒ 只有日结算行,指向下一个游戏日边界', () => {
    const view = widgetView(facade.state);
    expect(view.countdown).toHaveLength(1);
    const [dayLine] = view.countdown;
    expect(dayLine!.kind).toBe('日结算');
    expect(dayLine!.atGameMinutes).toBe(GAME_MINUTES_PER_DAY);
    expect(dayLine!.remainingGameMinutes).toBe(GAME_MINUTES_PER_DAY);
    expect(dayLine!.isWeekBoundary).toBe(false);
  });

  it('最近结果:尚无任何结果卡与稀有陈列 ⇒ 空列表', () => {
    const view = widgetView(facade.state);
    expect(view.recent).toEqual([]);
  });

  it('资源条:建会初始 = 起始金库 / 零荣誉 / 6 人满员 / 无名小会', () => {
    const view = widgetView(facade.state);
    expect(view.resources).toEqual({
      gold: VAULT.startingGold,
      honorPoints: 0,
      rosterCount: RECRUIT.baseRosterCap, // 会长角色 + 5 名初始团员
      rosterCap: RECRUIT.baseRosterCap,
      renown: '无名小会',
    });
    expect(view.guildName).toBe('星盾测试会');
    expect(view.clockGameMinutes).toBe(0);
  });
});

describe('T19 小组件:倒计时随时钟推进', () => {
  it('推进 1 游戏日以内:日结算剩余恰好减去增量;跨日后指向新的日边界', () => {
    const facade = new SimulationFacade(SEED, '星盾测试会');
    let view = widgetView(facade.state);
    const delta = 137; // 不跨日界的任意增量
    const output = facade.dispatch({ deltaGameMinutes: delta });
    view = widgetView(output.state);
    expect(view.clockGameMinutes).toBe(delta);
    expect(view.countdown[0]!.remainingGameMinutes).toBe(GAME_MINUTES_PER_DAY - delta);
  });

  it('恰在周边界前:日结算行标注周更(团本 CD 重置时刻)', () => {
    const facade = new SimulationFacade(SEED, '星盾测试会');
    // 推进到第 1 周最后一个游戏日的起点:下一个日界 = 周边界
    const output = facade.dispatch({
      deltaGameMinutes: GAME_MINUTES_PER_WEEK - GAME_MINUTES_PER_DAY,
    });
    const view = widgetView(output.state);
    const dayLine = view.countdown[0]!;
    expect(dayLine.kind).toBe('日结算');
    expect(dayLine.isWeekBoundary).toBe(true);
    expect(dayLine.targetName).toBe('周更');
    expect(dayLine.atGameMinutes).toBe(GAME_MINUTES_PER_WEEK);
  });
});

describe('T19 小组件:一轮中盘的派生视图(贪心机器人跑到第 3 周)', () => {
  // 复用 T18 的脚本机器人(只发会长指令 + 时间增量,门面接缝同源)
  const outcome: { state: GameState } = new RoundBot(SEED, '远征测试会').play(3);
  const view = widgetView(outcome.state);

  it('倒计时:开团中 ⇒ 团本夜行在最前,指向下一个游戏周边界;日结算行随后', () => {
    expect(outcome.state.raidPlan).toBeDefined(); // 前置:机器人本周确已开团
    expect(view.countdown.length).toBe(2);
    const [nightLine, dayLine] = view.countdown;
    expect(nightLine!.kind).toBe('团本夜');
    expect(nightLine!.targetName).toBeDefined();
    expect(nightLine!.atGameMinutes).toBeGreaterThan(outcome.state.clockGameMinutes);
    expect(nightLine!.atGameMinutes % GAME_MINUTES_PER_WEEK).toBe(0);
    expect(dayLine!.kind).toBe('日结算');
    expect(nightLine!.remainingGameMinutes).toBeGreaterThan(0);
    expect(dayLine!.remainingGameMinutes).toBeGreaterThan(0);
  });

  it('最近结果:结果卡与稀有陈列按时刻倒序、最新在前,不超上限', () => {
    expect(view.recent.length).toBeGreaterThan(0);
    expect(view.recent.length).toBeLessThanOrEqual(WIDGET_RECENT_LIMIT);
    for (let i = 0; i + 1 < view.recent.length; i++) {
      expect(view.recent[i]!.atGameMinutes).toBeGreaterThanOrEqual(
        view.recent[i + 1]!.atGameMinutes,
      );
    }
  });

  it('最近结果:下本结果卡如实映射(副本名/成败/掉落件数)', () => {
    const run = outcome.state.lastDungeonRun;
    expect(run).toBeDefined();
    const line = view.recent.find((entry) => entry.kind === '下本');
    expect(line).toBeDefined();
    expect(line!.kind === '下本' && line!.dungeonName).toBe(run!.dungeonName);
    expect(line!.kind === '下本' && line!.success).toBe(run!.success);
    expect(line!.kind === '下本' && line!.dropsTotal).toBe(run!.drops.length);
  });

  it('最近结果:团本夜结果卡如实映射(击杀数/全通或团灭止步处)', () => {
    const night = outcome.state.lastRaidNight;
    const line = view.recent.find((entry) => entry.kind === '团本');
    if (night === undefined) {
      expect(line).toBeUndefined(); // 前 3 周尚无团本夜 ⇒ 无团本行,不强造
      return;
    }
    expect(line?.kind).toBe('团本');
    if (line?.kind === '团本') {
      expect(line.raidName).toBe(night.raidName);
      expect(line.kills).toBe(night.bosses.filter((boss) => boss.killed).length);
      expect(line.bossCount).toBe(night.bosses.length);
      expect(line.cleared).toBe(night.cleared);
      if (!night.cleared) {
        expect(line.wipeBossName).toBe(night.wipe!.bossName);
      }
    }
  });

  it('资源条:与状态真值一致(金库/荣誉/名册/声望)', () => {
    const state = outcome.state;
    expect(view.resources.gold).toBe(state.vault.gold);
    expect(view.resources.honorPoints).toBe(state.honor.points);
    expect(view.resources.rosterCount).toBe(state.members.length);
    expect(view.resources.rosterCap).toBe(state.rosterCap);
    expect(view.guildName).toBe(state.guild.name);
  });
});
