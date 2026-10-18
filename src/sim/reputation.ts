/**
 * 声望系统(T12,GLOSSARY:声望等级/荣誉墙/名人堂/首杀):
 * 7 档 × 3 星的名望刻度,由首杀与里程碑加分驱动、自肥扣分,
 * 反向作用于申请池数量/质量(sim/recruit 按阶位取规格)与名册上限;
 * 荣誉墙陈列首杀徽章(带日期)、里程碑与稀有掉落;
 * 忠诚过低或长期坐冷板凳的团员自动退会留台词,进名人堂(去向与功绩)。
 *
 * 本模块只有纯函数,不消费随机链(台词与去向按团员 id 确定性取用),
 * 一切可调数值与文案在 content/reputation.ts(数据驱动)。
 * 结算编排在门面的日界/周边界结算(sim/facade.ts)。
 */

import { LEVELING } from '../content/maps';
import { RAID_BY_ID } from '../content/raids';
import { RECRUIT } from '../content/recruit';
import {
  DESTINATION_POOLS,
  FAREWELL_LINES,
  MILESTONES,
  RENOWN_RUNG_COUNT,
  RENOWN_SOURCES,
  RENOWN_TIERS,
  RESIGNATION,
  type DepartureReason,
  type MilestoneDef,
  type ReputationTierDef,
} from '../content/reputation';
import { GAME_MINUTES_PER_WEEK } from './clock';
import { averageItemLevel, guildAverageLevel } from './roster';
import type {
  FirstKillBadge,
  HallOfFameEntry,
  HonorWall,
  Member,
  RaidNightReport,
  RareDropRecord,
  Squad,
} from './state';

/**
 * 阶位门槛表(下标 = 阶位,值 = 达到该阶所需的累计声望值;阶 0 无门槛):
 * starPoints 是「档内累计」—— 1★/2★/3★ 分别到达该档基准 + starPoints[0..2],
 * 下一档从本档 3★ 门槛起算;由内容表推导,内容调档位分值不用动这里。
 */
const RUNG_THRESHOLDS: readonly number[] = (() => {
  const thresholds: number[] = [0];
  let tierBase = 0;
  for (const tier of RENOWN_TIERS) {
    const [star1, star2, star3] = tier.starPoints;
    thresholds.push(tierBase + star1!, tierBase + star2!, tierBase + star3!);
    tierBase += star3!; // 下一档从本档 3★ 门槛起
  }
  return thresholds;
})();

/** 声望值 → 阶位(0..RENOWN_RUNG_COUNT;负数按 0,超出按满阶封顶)。 */
export function renownRung(points: number): number {
  const value = Math.max(0, Math.floor(points));
  let rung = 0;
  for (let r = 1; r < RUNG_THRESHOLDS.length; r++) {
    if (value >= RUNG_THRESHOLDS[r]!) {
      rung = r;
    } else {
      break;
    }
  }
  return rung;
}

/** 阶位门槛:达到该阶所需的累计声望值(越界钳制)。 */
export function rungThreshold(rung: number): number {
  const clamped = Math.max(0, Math.min(RUNG_THRESHOLDS.length - 1, Math.floor(rung)));
  return RUNG_THRESHOLDS[clamped]!;
}

/** 阶位展开:档位定义 + 档序(0 起)+ 星级(0–3;满阶钳在末档 3 星)。 */
export function renownStanding(rung: number): {
  tierIndex: number;
  tier: ReputationTierDef;
  stars: number;
} {
  const clamped = Math.max(0, Math.min(RENOWN_RUNG_COUNT, Math.floor(rung)));
  const tierIndex = Math.min(Math.floor(clamped / 3), RENOWN_TIERS.length - 1);
  return { tierIndex, tier: RENOWN_TIERS[tierIndex]!, stars: clamped - tierIndex * 3 };
}

/** 阶位标签(事件与 UI 共用):「闻名一方 ★★」;零星只显示档名。 */
export function renownLabel(rung: number): string {
  const { tier, stars } = renownStanding(rung);
  return stars === 0 ? tier.name : `${tier.name} ${'★'.repeat(stars)}`;
}

/** 阶位 → 名册上限(baseRosterCap + 档位加成;GLOSSARY:名册上限随声望成长)。 */
export function rosterCapForRung(rung: number): number {
  return RECRUIT.baseRosterCap + renownStanding(rung).tier.rosterCapBonus;
}

/** 首杀加分:按团本难度档(1 起)取值,超出表尾按末档。 */
export function firstKillPointsForRaidTier(raidTier: number): number {
  const table = RENOWN_SOURCES.firstKillPointsByRaidTier;
  const index = Math.max(0, Math.min(table.length - 1, Math.floor(raidTier) - 1));
  return table[index]!;
}

/**
 * 从一份团本夜报告提取本会首杀(未入墙的击杀首领):
 * 同一首领只记一次(bossId 去重),按结算顺序成徽章。
 */
export function firstKillsFromRaidNight(
  report: RaidNightReport,
  wall: HonorWall,
): { badges: readonly FirstKillBadge[]; points: number } {
  const known = new Set(wall.firstKills.map((badge) => badge.bossId));
  const badges: FirstKillBadge[] = [];
  for (const boss of report.bosses) {
    if (!boss.killed || known.has(boss.bossId)) {
      continue;
    }
    known.add(boss.bossId);
    badges.push({
      raidId: report.raidId,
      raidName: report.raidName,
      bossId: boss.bossId,
      bossName: boss.name,
      atGameMinutes: report.atGameMinutes,
    });
  }
  return { badges, points: badges.length * firstKillPointsForRaidTier(raidTierOf(report)) };
}

/** 报告对应团本的难度档(内容表查不到时按 1 档计,防御旧档内容裁撤)。 */
function raidTierOf(report: RaidNightReport): number {
  return RAID_BY_ID.get(report.raidId)?.tier ?? 1;
}

/** 里程碑评估的当日信号(由门面从本日结算结果汇总;信号类里程碑一次性)。 */
export interface MilestoneSignals {
  /** 本日有 5 人本速通 */
  readonly dungeonClearedToday: boolean;
  /** 本夜有团本全通 */
  readonly raidClearedTonight: boolean;
  /** 本日有紫装被人穿上(团本或 5 人本) */
  readonly purpleEquippedToday: boolean;
}

/** 里程碑评估入参:状态侧刻度 + 当日信号 + 已达成清单(荣誉墙)。 */
export interface MilestoneContext {
  readonly members: readonly Member[];
  /** 公会金库历史收入累计 */
  readonly vaultIncomeTotal: number;
  readonly signals: MilestoneSignals;
  readonly earnedMilestoneIds: readonly string[];
}

/** 评估里程碑:返回本次新达成的里程碑(内容表顺序;未达成的不返)。 */
export function evaluateMilestones(context: MilestoneContext): readonly MilestoneDef[] {
  const earned = new Set(context.earnedMilestoneIds);
  const averageLevel = guildAverageLevel(context.members);
  return MILESTONES.filter((def) => {
    if (earned.has(def.id)) {
      return false;
    }
    switch (def.kind) {
      case 'avgLevel':
        return averageLevel >= (def.threshold ?? Infinity);
      case 'rosterSize':
        return context.members.length >= (def.threshold ?? Infinity);
      case 'maxLevelMember':
        return context.members.some((member) => member.level >= LEVELING.maxLevel);
      case 'firstDungeonClear':
        return context.signals.dungeonClearedToday;
      case 'firstRaidClear':
        return context.signals.raidClearedTonight;
      case 'firstPurpleEquipped':
        return context.signals.purpleEquippedToday;
      case 'vaultIncome':
        return context.vaultIncomeTotal >= (def.threshold ?? Infinity);
    }
  });
}

/**
 * 团本夜的稀有掉落入墙记录:被穿上的紫装(持有人 = 穿上者)。
 * 分解与流拍的紫装不陈列(墙上挂的是实实在在穿在身上的战利品)。
 */
export function rareDropsFromRaidNight(report: RaidNightReport): readonly RareDropRecord[] {
  const records: RareDropRecord[] = [];
  for (const boss of report.bosses) {
    for (const drop of boss.drops) {
      if (drop.quality === '紫' && drop.equipped) {
        records.push({
          slot: drop.slot,
          quality: drop.quality,
          itemLevel: drop.itemLevel,
          holder: drop.assignedTo ?? '?',
          source: report.raidName,
          atGameMinutes: report.atGameMinutes,
        });
      }
    }
  }
  return records;
}

/**
 * 冷板凳计数(日界结算):公会至少已有一支小队时,未编入任何小队的团员
 * 待命日数 +1,编入者清零;尚无任何小队的新会不计数(编成概念未开始)。
 */
export function accrueBenchDays(
  members: readonly Member[],
  squads: readonly Squad[],
): readonly Member[] {
  if (squads.length === 0) {
    return members;
  }
  const assigned = new Set(squads.flatMap((squad) => squad.memberIds));
  return members.map((member) =>
    assigned.has(member.id)
      ? member.benchDays === 0
        ? member
        : { ...member, benchDays: 0 }
      : { ...member, benchDays: member.benchDays + 1 },
  );
}

/** 自动退会裁决结果(事件与名人堂共用)。 */
export interface Resignation {
  readonly member: Member;
  readonly reason: DepartureReason;
}

/**
 * 自动退会条件(DESIGN:忠诚过低或长期冷板凳自动退会;会长角色除外):
 * 忠诚 ≤ loyaltyThreshold ⇒ 忠诚不足(优先);否则待命日数 ≥ benchDaysThreshold ⇒ 长期冷板凳。
 * 纯裁决:状态更替(除名/清编/入堂)由门面完成。
 */
export function autoResignations(members: readonly Member[]): readonly Resignation[] {
  const resignations: Resignation[] = [];
  for (const member of members) {
    if (member.isChairman) {
      continue; // 会长角色不退会(那是玩家自己的角色)
    }
    if (member.loyalty <= RESIGNATION.loyaltyThreshold) {
      resignations.push({ member, reason: '忠诚不足' });
    } else if (member.benchDays >= RESIGNATION.benchDaysThreshold) {
      resignations.push({ member, reason: '长期冷板凳' });
    }
  }
  return resignations;
}

/** 离会台词:按团员 id 在对应文案池中确定性取用(不消费随机链)。 */
export function farewellFor(member: Member, reason: DepartureReason): string {
  const pool = FAREWELL_LINES[reason];
  return pool[Math.abs(member.id) % pool.length] ?? pool[0]!;
}

/** 去向:按团员 id 在去向池中确定性取用(名人堂「去向」陈列)。 */
export function destinationFor(memberId: number): string {
  return DESTINATION_POOLS[Math.abs(memberId) % DESTINATION_POOLS.length] ?? DESTINATION_POOLS[0]!;
}

/** 名人堂条目:离会时刻的画像与功绩快照 + 台词与去向。 */
export function hallEntryFor(
  member: Member,
  reason: DepartureReason,
  atGameMinutes: number,
): HallOfFameEntry {
  return {
    memberId: member.id,
    name: member.name,
    classId: member.classId,
    specId: member.specId,
    level: member.level,
    itemLevel: averageItemLevel(member),
    joinedAtGameMinutes: member.joinedAtGameMinutes,
    leftAtGameMinutes: atGameMinutes,
    reason,
    farewell: farewellFor(member, reason),
    destination: destinationFor(member.id),
    bossKills: member.bossKills,
    rareLootWon: member.rareLootWon,
  };
}

/** 名人堂「功绩」陈列文案(UI 与事件日志共用)。 */
export function hallDeedsLine(entry: HallOfFameEntry): string {
  const weeks = Math.max(
    1,
    Math.ceil((entry.leftAtGameMinutes - entry.joinedAtGameMinutes) / GAME_MINUTES_PER_WEEK),
  );
  return `在会 ${weeks} 周 · 参与击杀 ${entry.bossKills} 名首领 · 紫装 ${entry.rareLootWon} 件 · Lv${entry.level}(装等 ${entry.itemLevel})`;
}
