/**
 * 5 人本表与结算数值配置(数据驱动内容)。
 *
 * 规则逻辑在 src/sim/encounter.ts(统一结算引擎)与 src/sim/dungeon.ts(下本活动);
 * 一切可调数值(难度、伐木次数、掉落档位、职能分、三段式边界)都在这里,
 * 调优不动模拟代码。
 * 命名遵循 ADR-0002:副本名一律原创,不使用既有 IP 专有名词。
 * GLOSSARY:内容阶梯 = 练级 → 5 人本 → ……;5 人本按 普通/高级/困难/英雄 四档推进,
 * 本表先开放第一座普通档;后续工单在此扩展。
 */

import type { Quality } from './gear';

/** 5 人本的难度档(四档;GLOSSARY:内容阶梯)。 */
export type DungeonTier = '普通' | '高级' | '困难' | '英雄';

/** 5 人本定义(5 人本 = 1 小队,DESIGN.md「编成」)。 */
export interface DungeonDef {
  readonly id: string;
  readonly name: string;
  /** 一句话风情描述(UI 展示)。 */
  readonly description: string;
  readonly tier: DungeonTier;
  /** 解锁门槛:公会平均等级(与练级地图同一刻度)。 */
  readonly unlockAverageLevel: number;
  /**
   * 难度目标(战力刻度):结算引擎把小队战力与它比较,
   * 低于(目标 − failMargin)必败、高于(目标 + winMargin)必胜、之间线性。
   */
  readonly difficultyTarget: number;
  /** 每游戏日自动下本次数(自动层:进驻后每日按此结算)。 */
  readonly runsPerDay: number;
  /** 每次胜利掉落的装备件数。 */
  readonly dropsPerRun: number;
  /** 掉落装等基准(品质加成与扰动另计,见 DUNGEON_SETTLEMENT)。 */
  readonly dropItemLevel: number;
  /** 每次下本(无论成败)每人疲劳积累。 */
  readonly fatiguePerRun: number;
}

/** 首批 5 人本:第一座普通档(DESIGN 全量 12–15 座,后续工单补)。 */
export const DUNGEONS: readonly DungeonDef[] = [
  {
    id: 'echo-catacomb',
    name: '回声墓道',
    description: '青苔覆壁的旧墓道,亡者的低语顺着风道传出老远,矿工们再没上来。',
    tier: '普通',
    unlockAverageLevel: 10,
    difficultyTarget: 36,
    runsPerDay: 2,
    dropsPerRun: 2,
    dropItemLevel: 18,
    fatiguePerRun: 6,
  },
];

/** 按 id 查 5 人本(sim 结算与 UI 展示共用)。 */
export const DUNGEON_BY_ID: ReadonlyMap<string, DungeonDef> = new Map(
  DUNGEONS.map((dungeon) => [dungeon.id, dungeon]),
);

/** 掉落品质抽取权重(与建会装备表 QUALITY_RULES 分档:副本掉落品质整体更好)。 */
export interface DropQualityRule {
  readonly quality: Quality;
  readonly weight: number;
}

export const DUNGEON_DROP_QUALITY: readonly DropQualityRule[] = [
  { quality: '白', weight: 25 },
  { quality: '绿', weight: 45 },
  { quality: '蓝', weight: 25 },
  { quality: '紫', weight: 5 },
];

/** 结算引擎可调数值(公式本身在 sim/encounter.ts 与 sim/dungeon.ts)。 */
export interface DungeonSettlementConfig {
  /** 职能结构分:小队每名坦克/治疗/输出计入的战力(封顶件数各 2/2/3)。 */
  readonly roleScore: {
    readonly perTank: number;
    readonly tankCap: number;
    readonly perHealer: number;
    readonly healerCap: number;
    readonly perDps: number;
    readonly dpsCap: number;
  };
  /** 三段式边界:战力 ≤ 目标 − failMargin 必败;≥ 目标 + winMargin 必胜;之间线性。 */
  readonly failMargin: number;
  readonly winMargin: number;
  /** 掉落装等扰动幅度(±dropJitter)。 */
  readonly dropJitter: number;
}

export const DUNGEON_SETTLEMENT: DungeonSettlementConfig = {
  // 标准编成 1 坦 1 奶 3 输出 = 21 分;2 坦 2 奶 1 输出 = 17 分(输出多 = 打得快)。
  roleScore: { perTank: 3, tankCap: 2, perHealer: 3, healerCap: 2, perDps: 5, dpsCap: 3 },
  failMargin: 5,
  winMargin: 5,
  dropJitter: 1,
};
