/**
 * 日程派生量:活动队列与下一场结算倒计时(T9)。
 *
 * 纯派生模块:只读状态与内容表,不推进时间、不产生随机、不修改状态
 * (日程页与将来的桌面小组件共用)。边界的取法与门面 advanceClock 的
 * 日/周边界完全同式 —— 倒计时指的时刻就是自动层真正结算的时刻。
 */

import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK } from './clock';
import { squadDungeon } from './dungeon';
import { squadLevelingMap } from './leveling';
import type { GameState } from './state';

/** 活动队列条目:一支小队已排的自动层活动(GLOSSARY:自动层/已排活动)。 */
export interface ActivityEntry {
  readonly squadId: number;
  /** 第几小队(1 起,按编成顺序) */
  readonly squadOrdinal: number;
  /** '练级' = 进驻练级地图;'下本' = 进驻 5 人本 */
  readonly kind: '练级' | '下本';
  /** 内容名(地图名/副本名) */
  readonly name: string;
  /** 高效/休闲(练级)或 普通/高级/困难/英雄(下本) */
  readonly tier: string;
  /** 每游戏日的结算量:练级 = 每日经验收益;下本 = 每日次数 */
  readonly perDay: number;
}

/**
 * 活动队列:按编成顺序列出全部进行中的小队活动(已排活动)。
 * 活动 id 失效(内容表裁撤)的小队不在队列中 —— 与结算对失效 id 的防御一致。
 */
export function activityQueue(state: GameState): readonly ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  state.squads.forEach((squad, index) => {
    const leveling = squadLevelingMap(squad);
    if (leveling !== undefined) {
      entries.push({
        squadId: squad.id,
        squadOrdinal: index + 1,
        kind: '练级',
        name: leveling.name,
        tier: leveling.tier,
        perDay: leveling.xpPerDay,
      });
      return;
    }
    const dungeon = squadDungeon(squad);
    if (dungeon !== undefined) {
      entries.push({
        squadId: squad.id,
        squadOrdinal: index + 1,
        kind: '下本',
        name: dungeon.name,
        tier: dungeon.tier,
        perDay: dungeon.runsPerDay,
      });
    }
  });
  return entries;
}

/** 下一场结算倒计时:自动层的下一个日界(练级/下本/申请池都在此结算)。 */
export interface SettlementCountdown {
  /** 结算时刻(自建会起累计的游戏分钟,绝对值) */
  readonly atGameMinutes: number;
  /** 距当前时钟的剩余游戏分钟(恒 > 0) */
  readonly remainingGameMinutes: number;
  /** 该日界是否同时是周边界(周更:团本 CD 重置) */
  readonly isWeekBoundary: boolean;
}

/**
 * 下一场结算 = 下一个游戏日边界(与门面 advanceClock 的逐日结算同式)。
 * 无论有没有小队在活动,日界都会结算(日更文案、申请池刷新、休整恢复),
 * 因此倒计时恒存在;周边界(团本 CD 重置)叠加标注。
 */
export function nextSettlement(state: GameState): SettlementCountdown {
  const clock = state.clockGameMinutes;
  const nextDayAt = (Math.floor(clock / GAME_MINUTES_PER_DAY) + 1) * GAME_MINUTES_PER_DAY;
  return {
    atGameMinutes: nextDayAt,
    remainingGameMinutes: nextDayAt - clock,
    isWeekBoundary: nextDayAt % GAME_MINUTES_PER_WEEK === 0,
  };
}

/** 团本夜排期:开团安排的结算时刻(派生量;团本 CD = 游戏周,DESIGN)。 */
export interface RaidNightSchedule {
  /** 团本夜时刻(下一个游戏周边界,自建会起累计的游戏分钟)。 */
  readonly atGameMinutes: number;
  /** 距当前时钟的剩余游戏分钟(恒 > 0)。 */
  readonly remainingGameMinutes: number;
}

/**
 * 下一个团本夜 = 下一个游戏周边界(与门面 advanceClock 的周边界结算同式):
 * 开团安排在跨过周边界时整夜结算。未开团时为 undefined。
 */
export function nextRaidNight(state: GameState): RaidNightSchedule | undefined {
  if (state.raidPlan === undefined) {
    return undefined;
  }
  const clock = state.clockGameMinutes;
  const nextWeekAt = (Math.floor(clock / GAME_MINUTES_PER_WEEK) + 1) * GAME_MINUTES_PER_WEEK;
  return { atGameMinutes: nextWeekAt, remainingGameMinutes: nextWeekAt - clock };
}
