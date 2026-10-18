/**
 * 小组件派生量(T19,GLOSSARY:小组件模式)。
 *
 * 纯派生模块(与 sim/schedule.ts 同式):只读状态与内容表,不推进时间、
 * 不产生随机、不修改状态。桌面小组件(贴角常驻小窗)的全部展示数据都由
 * 这里派生 —— 倒计时直接复用 sim/schedule 的取法,指的时刻就是自动层
 * 真正结算的时刻(与门面 advanceClock 的日/周边界完全同式)。
 * 文案拼装在 UI(ui/widget.ts);这里只给结构化数据。
 */

import { RAID_BY_ID } from '../content/raids';
import type { GearSlot, Quality } from '../content/gear';
import { nextRaidNight, nextSettlement } from './schedule';
import { renownLabel, renownRung } from './reputation';
import type { GameState } from './state';

/** 小组件常驻行的上限:窗口很小,最近结果最多陈列这几条(最新在前)。 */
export const WIDGET_RECENT_LIMIT = 4;

/** 倒计时行:「下一场」= 团本夜(开团中,周边界)优先,日结算(日边界)恒在。 */
export interface WidgetCountdownLine {
  /** '团本夜' = 开团安排的整夜结算;'日结算' = 自动层的逐日边界。 */
  readonly kind: '团本夜' | '日结算';
  /** 目标名:团本夜 = 团本名;日结算在恰逢周边界时标注「周更」。 */
  readonly targetName?: string;
  /** 该日界是否同时是周边界(周更:团本 CD 重置)。 */
  readonly isWeekBoundary: boolean;
  /** 结算时刻(自建会起累计的游戏分钟,绝对值)。 */
  readonly atGameMinutes: number;
  /** 距当前时钟的剩余游戏分钟(恒 > 0)。 */
  readonly remainingGameMinutes: number;
}

/** 最近结果与掉落行(结构化;文案在 UI 拼)。 */
export type WidgetRecentLine =
  | {
      readonly kind: '团本';
      readonly atGameMinutes: number;
      readonly raidName: string;
      /** 击杀首领数 / 首领总数。 */
      readonly kills: number;
      readonly bossCount: number;
      /** 全通 = true;团灭 = false(wipeBossName = 止步首领)。 */
      readonly cleared: boolean;
      readonly wipeBossName?: string;
    }
  | {
      readonly kind: '下本';
      readonly atGameMinutes: number;
      readonly dungeonName: string;
      readonly squadOrdinal: number;
      readonly success: boolean;
      /** 掉落件数与其中被穿上的件数。 */
      readonly dropsTotal: number;
      readonly dropsEquipped: number;
    }
  | {
      readonly kind: '战场';
      readonly atGameMinutes: number;
      readonly battlefieldName: string;
      readonly victory: boolean;
      /** 本场荣誉进账(胜负皆有)。 */
      readonly honorGained: number;
    }
  | {
      readonly kind: '掉落';
      readonly atGameMinutes: number;
      /** 穿上者。 */
      readonly holder: string;
      readonly slot: GearSlot;
      readonly quality: Quality;
      readonly itemLevel: number;
      /** 来源文案(团本名或 5 人本名)。 */
      readonly source: string;
    };

/** 资源条:双钱包的公家一侧 + 荣誉点 + 名册刻度。 */
export interface WidgetResources {
  /** 公会金库余额(GLOSSARY:公会金库)。 */
  readonly gold: number;
  /** 可花费荣誉点(GLOSSARY:荣誉点)。 */
  readonly honorPoints: number;
  /** 在册团员数 / 名册上限。 */
  readonly rosterCount: number;
  readonly rosterCap: number;
  /** 声望档位文案(如「无名小会」;7 档 × 3 星)。 */
  readonly renown: string;
}

/** 小组件完整视图数据(倒计时 + 最近结果掉落 + 资源条)。 */
export interface WidgetView {
  readonly guildName: string;
  readonly clockGameMinutes: number;
  readonly countdown: readonly WidgetCountdownLine[];
  readonly recent: readonly WidgetRecentLine[];
  readonly resources: WidgetResources;
}

/**
 * 派生小组件视图。开团中 ⇒ 团本夜行在最前(主行),日结算行随后(辅行);
 * 未开团 ⇒ 只有日结算行。最近结果取自三张结果卡与荣誉墙稀有陈列,
 * 按发生时刻倒序、最新在前,截到 WIDGET_RECENT_LIMIT 条。
 */
export function widgetView(state: GameState): WidgetView {
  const countdown: WidgetCountdownLine[] = [];
  const night = nextRaidNight(state);
  if (night !== undefined) {
    countdown.push({
      kind: '团本夜',
      targetName: RAID_BY_ID.get(state.raidPlan?.raidId ?? '')?.name ?? '安排失效',
      isWeekBoundary: true,
      atGameMinutes: night.atGameMinutes,
      remainingGameMinutes: night.remainingGameMinutes,
    });
  }
  const day = nextSettlement(state);
  countdown.push({
    kind: '日结算',
    ...(day.isWeekBoundary ? { targetName: '周更' } : {}),
    isWeekBoundary: day.isWeekBoundary,
    atGameMinutes: day.atGameMinutes,
    remainingGameMinutes: day.remainingGameMinutes,
  });

  const recent: WidgetRecentLine[] = [];
  const raid = state.lastRaidNight;
  if (raid !== undefined) {
    recent.push({
      kind: '团本',
      atGameMinutes: raid.atGameMinutes,
      raidName: raid.raidName,
      kills: raid.bosses.filter((boss) => boss.killed).length,
      bossCount: raid.bosses.length,
      cleared: raid.cleared,
      ...(raid.wipe !== undefined ? { wipeBossName: raid.wipe.bossName } : {}),
    });
  }
  const dungeon = state.lastDungeonRun;
  if (dungeon !== undefined) {
    recent.push({
      kind: '下本',
      atGameMinutes: dungeon.atGameMinutes,
      dungeonName: dungeon.dungeonName,
      squadOrdinal: dungeon.squadOrdinal,
      success: dungeon.success,
      dropsTotal: dungeon.drops.length,
      dropsEquipped: dungeon.drops.filter((drop) => drop.equipped).length,
    });
  }
  const battlefield = state.lastBattlefieldReport;
  if (battlefield !== undefined) {
    recent.push({
      kind: '战场',
      atGameMinutes: battlefield.atGameMinutes,
      battlefieldName: battlefield.battlefieldName,
      victory: battlefield.victory,
      honorGained: battlefield.honorGained,
    });
  }
  for (const record of state.honorWall.rareDrops.slice(-WIDGET_RECENT_LIMIT)) {
    recent.push({
      kind: '掉落',
      atGameMinutes: record.atGameMinutes,
      holder: record.holder,
      slot: record.slot,
      quality: record.quality,
      itemLevel: record.itemLevel,
      source: record.source,
    });
  }
  recent.sort((a, b) => b.atGameMinutes - a.atGameMinutes);

  return {
    guildName: state.guild.name,
    clockGameMinutes: state.clockGameMinutes,
    countdown,
    recent: recent.slice(0, WIDGET_RECENT_LIMIT),
    resources: {
      gold: state.vault.gold,
      honorPoints: state.honor.points,
      rosterCount: state.members.length,
      rosterCap: state.rosterCap,
      renown: renownLabel(renownRung(state.renownPoints)),
    },
  };
}
