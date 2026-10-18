/**
 * 5 人本表、难度档表与结算数值配置(数据驱动内容)。
 *
 * 规则逻辑在 src/sim/encounter.ts(统一结算引擎)与 src/sim/dungeon.ts(下本活动);
 * 门槛判定与阶梯完整性校验在 src/sim/ladder.ts(内容阶梯引擎);
 * 一切可调数值(难度档、掉落品质、伐木次数、职能分、三段式边界)都在这里,
 * 调优不动模拟代码。
 * 命名遵循 ADR-0002:副本名一律原创,擦边致敬对照表只在开发文档
 * (docs/naming.md),不进游戏。
 * GLOSSARY:内容阶梯 = 练级 → 5 人本 → ……;5 人本按 普通/高级/困难/英雄 四档推进,
 * 解锁门槛 = 公会平均等级 + 公会平均装等(双维,任一未达标即锁定)。
 * 新增副本 = 追加一条数据(档位在难度档表里选,门槛不越过更高档;
 * 结构校验见 sim/ladder.ts),不需要改任何代码。
 */

import type { Quality } from './gear';

/** 5 人本的难度档(四档;GLOSSARY:内容阶梯)。 */
export type DungeonTier = '普通' | '高级' | '困难' | '英雄';

/** 掉落品质抽取权重(难度档表的组成部分:档越高稀有品质权重越高)。 */
export interface DropQualityRule {
  readonly quality: Quality;
  readonly weight: number;
}

/** 难度档定义:内容阶梯上的一级;掉落品质分布随档位抬升(难度档差异)。 */
export interface DungeonTierDef {
  readonly id: DungeonTier;
  /** 阶梯序(1 起,普通 → 高级 → 困难 → 英雄;不允许跳级)。 */
  readonly order: number;
  /** 档位一句话描述(UI 展示)。 */
  readonly description: string;
  /** 该档胜利掉落的品质权重(与建会装备表 QUALITY_RULES 分档:副本掉落整体更好)。 */
  readonly dropQuality: readonly DropQualityRule[];
}

/** 难度档表:四档按阶梯序排列;紫装权重逐档抬升。 */
export const DUNGEON_TIERS: readonly DungeonTierDef[] = [
  {
    id: '普通',
    order: 1,
    description: '入门梯子:装等门槛低,掉落以白绿为主,练级期的第一口装备。',
    dropQuality: [
      { quality: '白', weight: 25 },
      { quality: '绿', weight: 45 },
      { quality: '蓝', weight: 25 },
      { quality: '紫', weight: 5 },
    ],
  },
  {
    id: '高级',
    order: 2,
    description: '进阶梯子:蓝装开始常见,紫装偶有惊喜。',
    dropQuality: [
      { quality: '白', weight: 15 },
      { quality: '绿', weight: 45 },
      { quality: '蓝', weight: 30 },
      { quality: '紫', weight: 10 },
    ],
  },
  {
    id: '困难',
    order: 3,
    description: '高段梯子:蓝装为主力,紫装成为稳定目标。',
    dropQuality: [
      { quality: '白', weight: 8 },
      { quality: '绿', weight: 37 },
      { quality: '蓝', weight: 40 },
      { quality: '紫', weight: 15 },
    ],
  },
  {
    id: '英雄',
    order: 4,
    description: '顶段梯子:不掉白装,紫装两成,团本前的最后一步。',
    dropQuality: [
      { quality: '白', weight: 0 },
      { quality: '绿', weight: 30 },
      { quality: '蓝', weight: 50 },
      { quality: '紫', weight: 20 },
    ],
  },
];

/** 按档位查难度档定义(sim 掉落与 UI 展示共用)。 */
export const DUNGEON_TIER_BY_ID: ReadonlyMap<DungeonTier, DungeonTierDef> = new Map(
  DUNGEON_TIERS.map((tier) => [tier.id, tier]),
);

/**
 * 解锁门槛:双维刻度(内容阶梯引擎,判定规则在 sim/ladder.ts)。
 * 任一维未达标即锁定(未达标不可见/不可进入)。
 */
export interface DungeonUnlockGates {
  /** 公会平均等级门槛(与练级地图同一刻度)。 */
  readonly averageLevel: number;
  /** 公会平均装等门槛(名册全员装等均值的向下取整)。 */
  readonly averageItemLevel: number;
}

/** 5 人本定义(5 人本 = 1 小队,DESIGN.md「编成」)。 */
export interface DungeonDef {
  readonly id: string;
  readonly name: string;
  /** 一句话风情描述(UI 展示)。 */
  readonly description: string;
  readonly tier: DungeonTier;
  /** 解锁门槛:公会平均等级 + 公会平均装等(双维)。 */
  readonly unlock: DungeonUnlockGates;
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

/**
 * 全量 5 人本:四档 × 4/4/4/3 座,共 15 座(T18 全量表:DESIGN 12–15 座的上沿)。
 * 按难度档与门槛升序排列;门槛双维随档位递增(不跳级),
 * 每档掉落装等抬高到足以企及下一档的装等门槛(装备阶梯自洽)。
 * 伐木节奏按「一轮 6–8 游戏周」粗调:普通/高级每日 3 次、困难/英雄每日 2 次,
 * 掉落装等始终高于下一座的装等门槛 —— 5 人本是装备的主引擎,团本提供尖端与套装。
 */
export const DUNGEONS: readonly DungeonDef[] = [
  {
    id: 'echo-catacomb',
    name: '回声墓道',
    description: '青苔覆壁的旧墓道,亡者的低语顺着风道传出老远,矿工们再没上来。',
    tier: '普通',
    unlock: { averageLevel: 10, averageItemLevel: 8 },
    difficultyTarget: 36,
    runsPerDay: 3,
    dropsPerRun: 3,
    dropItemLevel: 24,
    fatiguePerRun: 5,
  },
  {
    id: 'abyssal-blackwater',
    name: '深渊黑泉',
    description: '海面下废弃的月神祭坛,黑水从裂缝里涌出来,鱼人围着它做弥撒。',
    tier: '普通',
    unlock: { averageLevel: 12, averageItemLevel: 12 },
    difficultyTarget: 40,
    runsPerDay: 3,
    dropsPerRun: 3,
    dropItemLevel: 28,
    fatiguePerRun: 5,
  },
  {
    id: 'howling-spire',
    name: '狼嚎尖塔',
    description: '尖塔里彻夜回荡狼嚎,领主死了很多年,他的猎犬还没有。',
    tier: '普通',
    unlock: { averageLevel: 14, averageItemLevel: 16 },
    difficultyTarget: 44,
    runsPerDay: 3,
    dropsPerRun: 3,
    dropItemLevel: 32,
    fatiguePerRun: 5,
  },
  {
    id: 'glimmer-well',
    name: '萤光水窟',
    description: '洞顶的萤苔把水面照成一面碎镜,捞宝的人总忍不住多看一眼自己。',
    tier: '普通',
    unlock: { averageLevel: 16, averageItemLevel: 20 },
    difficultyTarget: 50,
    runsPerDay: 3,
    dropsPerRun: 3,
    dropItemLevel: 36,
    fatiguePerRun: 5,
  },
  {
    id: 'clockwork-deepcity',
    name: '发条深城',
    description: '一座自己会走的城市:齿轮咬着齿轮,发条兵巡逻在无人的街灯下。',
    tier: '高级',
    unlock: { averageLevel: 21, averageItemLevel: 26 },
    difficultyTarget: 56,
    runsPerDay: 3,
    dropsPerRun: 3,
    dropItemLevel: 42,
    fatiguePerRun: 6,
  },
  {
    id: 'scarlet-cloister',
    name: '赤祷回廊',
    description: '红袍僧侣把祷词念成了命令,回廊尽头的水晶里封着他们信的东西。',
    tier: '高级',
    unlock: { averageLevel: 24, averageItemLevel: 31 },
    difficultyTarget: 62,
    runsPerDay: 3,
    dropsPerRun: 3,
    dropItemLevel: 47,
    fatiguePerRun: 6,
  },
  {
    id: 'thunder-crypt',
    name: '雷柩地窟',
    description: '葬在雷暴频发的矿窟里是本地贵族的时尚,石棺自己会挪位置。',
    tier: '高级',
    unlock: { averageLevel: 27, averageItemLevel: 36 },
    difficultyTarget: 68,
    runsPerDay: 3,
    dropsPerRun: 3,
    dropItemLevel: 52,
    fatiguePerRun: 6,
  },
  {
    id: 'bramble-vault',
    name: '荆棘宝库',
    description: '有生命的荆棘替主人看守金库,看守得越好,薪水越是喂给荆棘。',
    tier: '高级',
    unlock: { averageLevel: 30, averageItemLevel: 41 },
    difficultyTarget: 74,
    runsPerDay: 3,
    dropsPerRun: 3,
    dropItemLevel: 57,
    fatiguePerRun: 6,
  },
  {
    id: 'sandfury-altar',
    name: '沙怒祭坛',
    description: '沙丘环抱的祭坛,鼓声一响,成百的骸骨从沙里站起来排队。',
    tier: '困难',
    unlock: { averageLevel: 36, averageItemLevel: 46 },
    difficultyTarget: 80,
    runsPerDay: 2,
    dropsPerRun: 8,
    dropItemLevel: 62,
    fatiguePerRun: 8,
  },
  {
    id: 'colossus-cradle',
    name: '巨像摇篮',
    description: '石窟里横着一尊未完工的石巨像,凿子声千年未停,只是没人在场。',
    tier: '困难',
    unlock: { averageLevel: 39, averageItemLevel: 51 },
    difficultyTarget: 86,
    runsPerDay: 2,
    dropsPerRun: 8,
    dropItemLevel: 67,
    fatiguePerRun: 8,
  },
  {
    id: 'tidegate-forge',
    name: '潮门锻造场',
    description: '海水每次灌进锻场都带来新货,潮水退去时留下的成品格外锋利。',
    tier: '困难',
    unlock: { averageLevel: 42, averageItemLevel: 56 },
    difficultyTarget: 92,
    runsPerDay: 2,
    dropsPerRun: 8,
    dropItemLevel: 72,
    fatiguePerRun: 8,
  },
  {
    id: 'hollow-spire',
    name: '虚空尖塔',
    description: '塔里每一层都比外面看起来大,爬塔的人在里面老得很慢,死得很快。',
    tier: '困难',
    unlock: { averageLevel: 45, averageItemLevel: 61 },
    difficultyTarget: 98,
    runsPerDay: 2,
    dropsPerRun: 8,
    dropItemLevel: 77,
    fatiguePerRun: 8,
  },
  {
    id: 'bone-lyceum',
    name: '白骨书院',
    description: '亡灵法术的最高学府,图书馆的每本书都是用不上课的学生装订的。',
    tier: '英雄',
    unlock: { averageLevel: 50, averageItemLevel: 66 },
    difficultyTarget: 104,
    runsPerDay: 2,
    dropsPerRun: 8,
    dropItemLevel: 82,
    fatiguePerRun: 10,
  },
  {
    id: 'burning-sanctum',
    name: '焚城圣所',
    description: '全城一夜烧尽,大教堂完好无损;圣坛上的火至今没有凉的意思。',
    tier: '英雄',
    unlock: { averageLevel: 53, averageItemLevel: 62 },
    difficultyTarget: 100,
    runsPerDay: 2,
    dropsPerRun: 8,
    dropItemLevel: 78,
    fatiguePerRun: 10,
  },
  {
    id: 'umbral-citadel',
    name: '暮晶城塞',
    description: '黑曜石砌成的城塞吸走光线,守军早已死绝,换岗的钟声还在响。',
    tier: '英雄',
    unlock: { averageLevel: 56, averageItemLevel: 66 },
    difficultyTarget: 108,
    runsPerDay: 2,
    dropsPerRun: 8,
    dropItemLevel: 84,
    fatiguePerRun: 10,
  },
];

/** 按 id 查 5 人本(sim 结算与 UI 展示共用)。 */
export const DUNGEON_BY_ID: ReadonlyMap<string, DungeonDef> = new Map(
  DUNGEONS.map((dungeon) => [dungeon.id, dungeon]),
);

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
