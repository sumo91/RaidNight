/**
 * PvP 内容表(数据驱动内容,T16):战场梯度、荣誉阶梯(军衔)与军装。
 *
 * 规则逻辑在 src/sim/pvp.ts(战场结算、荣誉/军衔派生量与军装兑换裁决在门面);
 * 成败复用统一结算引擎(src/sim/encounter.ts,不另起炉灶)。
 * 一切可调数值(难度目标、荣誉产出、军衔门槛、军装价格与战场向属性)都在这里,
 * 调优不动模拟代码。
 * 命名遵循 ADR-0002:战场名、军衔名与军装套装名一律原创,擦边致敬对照表只在
 * 开发文档(docs/naming.md),不进游戏。
 * GLOSSARY:战场 = 分梯度的组队 PvP 活动,荣誉与军装的主要来源;
 * 荣誉阶梯 = 战场荣誉的段位与军衔体系。竞技场不在 v1(DESIGN v1 边界)。
 */

import type { DungeonUnlockGates } from './dungeons';
import { GEAR_SLOTS, type GearSlot, type Quality } from './gear';

/** 战场结算可调数值(公式与流程在 sim/pvp.ts)。 */
export interface PvpSettlementConfig {
  /** 一座战场同时编入的小队上限(战场队 = 2–3 小队,DESIGN「编成」)。 */
  readonly maxSquadsPerBattlefield: number;
  /** 胜场士气(心情)提升。 */
  readonly victoryMoodBoost: number;
  /** 败场士气(心情)打击。 */
  readonly defeatMoodHit: number;
}

export const PVP_SETTLEMENT: PvpSettlementConfig = {
  maxSquadsPerBattlefield: 3,
  victoryMoodBoost: 3,
  defeatMoodHit: 2,
};

/** 战场定义(GLOSSARY:分梯度的组队 PvP 活动)。 */
export interface BattlefieldDef {
  readonly id: string;
  readonly name: string;
  /** 一句话风情描述(UI 展示)。 */
  readonly description: string;
  /** 梯度(1 起;梯度越高敌人越强、荣誉越厚,按梯度匹配对战)。 */
  readonly gradient: number;
  /** 解锁门槛:公会平均等级 + 公会平均装等(双维,与 5 人本同一判定)。 */
  readonly unlock: DungeonUnlockGates;
  /** 敌方难度目标(战力刻度,统一结算引擎)。 */
  readonly difficultyTarget: number;
  /** 每游戏日自动开打的场次。 */
  readonly battlesPerDay: number;
  /** 胜一场的荣誉点产出(同时计入生涯荣誉)。 */
  readonly honorPerWin: number;
  /** 败一场的安慰荣誉(战场没有空手而归)。 */
  readonly honorPerLoss: number;
  /** 每场(无论胜负)每名队员的疲劳积累。 */
  readonly fatiguePerBattle: number;
}

/**
 * 首批战场:三梯度各一座(后续工单在此扩表)。门槛沿内容阶梯不跳级;
 * 难度目标按「2 小队 = 开荒悬念、3 小队 = 稳压」标定 —— 战场队规模
 * (2–3 小队)经结算引擎的职能封顶缩放(小队数)进入战力。
 */
export const BATTLEGROUNDS: readonly BattlefieldDef[] = [
  {
    id: 'gravel-bulwark',
    name: '砾石哨垒',
    description: '废弃矿场上抢来的哨塔与矿点,旗子插到哪,补给车就敢开到哪。',
    gradient: 1,
    unlock: { averageLevel: 20, averageItemLevel: 16 },
    difficultyTarget: 66,
    battlesPerDay: 2,
    honorPerWin: 30,
    honorPerLoss: 10,
    fatiguePerBattle: 7,
  },
  {
    id: 'frostring-vale',
    name: '霜环林谷',
    description: '冻土林谷里两座营地隔着雪线对峙,谁的旗先扛回营地,谁的战歌就响彻山谷。',
    gradient: 2,
    unlock: { averageLevel: 36, averageItemLevel: 34 },
    difficultyTarget: 88,
    battlesPerDay: 2,
    honorPerWin: 55,
    honorPerLoss: 18,
    fatiguePerBattle: 8,
  },
  {
    id: 'emberwind-basin',
    name: '烬风盆地',
    description: '烧穿了半个盆地的会战绞肉场,增援的号角从开战那天起就没停过。',
    gradient: 3,
    unlock: { averageLevel: 52, averageItemLevel: 58 },
    difficultyTarget: 110,
    battlesPerDay: 2,
    honorPerWin: 90,
    honorPerLoss: 30,
    fatiguePerBattle: 9,
  },
];

/** 按 id 查战场(sim 结算与 UI 展示共用)。 */
export const BATTLEFIELD_BY_ID: ReadonlyMap<string, BattlefieldDef> = new Map(
  BATTLEGROUNDS.map((battlefield) => [battlefield.id, battlefield]),
);

/** 军衔定义(GLOSSARY:荣誉阶梯 = 战场荣誉的段位与军衔体系)。 */
export interface HonorRankDef {
  readonly id: string;
  /** 军衔名(UI 展示;原创命名,对照见 docs/naming.md)。 */
  readonly name: string;
  /** 生涯荣誉门槛(达到即晋升;阶 0 无门槛)。 */
  readonly threshold: number;
  /** 一句话军衔注解(UI 展示)。 */
  readonly blurb: string;
}

/**
 * 荣誉阶梯:六阶军衔,由生涯荣誉(只增不减,兑换军装不降衔)驱动;
 * 门槛按中期战场日产出(约 60–110 荣誉/日)标定,一轮之内心怀统帅。
 */
export const HONOR_RANKS: readonly HonorRankDef[] = [
  { id: 'recruit', name: '列兵', threshold: 0, blurb: '刚领到战旗绑带的新面孔。' },
  { id: 'sergeant', name: '中士', threshold: 150, blurb: '战场点名时有人应了。' },
  { id: 'staff-sergeant', name: '军士长', threshold: 450, blurb: '新兵蛋子开始学你说话。' },
  { id: 'centurion', name: '百夫长', threshold: 1100, blurb: '一声令下,百人转向。' },
  { id: 'war-watch', name: '督战官', threshold: 2400, blurb: '你站的土坡就是指挥所。' },
  { id: 'honor-marshal', name: '荣誉统帅', threshold: 4800, blurb: '军功簿的最后一页写的是你。' },
];

/** 军衔阶数(荣誉阶梯的段位数)。 */
export const HONOR_RANK_COUNT = HONOR_RANKS.length;

/** 军装套装定义:荣誉点兑换的 PvP 装备(第二装备来源,DESIGN「PvP」)。 */
export interface HonorGearSetDef {
  readonly id: string;
  /** 套装名(原创命名,对照见 docs/naming.md)。 */
  readonly name: string;
  /** 单件品质。 */
  readonly quality: Quality;
  /** 单件装等(与同时期 PvE 装备同档)。 */
  readonly itemLevel: number;
  /** 单件战场向属性(战场结算计入战力,PvE 结算不计)。 */
  readonly pvpPower: number;
  /** 单件荣誉点价格。 */
  readonly costHonor: number;
  /** 需要的军衔阶(1 起:1 = 列兵 …… 6 = 荣誉统帅)。 */
  readonly requiredRankOrder: number;
}

/**
 * 军装套装表:军士长战装(中期,与困难本装备同档)与百夫长战装(后期,
 * 与英雄本装备同档);战场向属性让军装在战场上越于同装等 PvE 装。
 */
export const HONOR_GEAR_SETS: readonly HonorGearSetDef[] = [
  {
    id: 'staff-sergeant',
    name: '军士长战装',
    quality: '蓝',
    itemLevel: 46,
    pvpPower: 2,
    costHonor: 90,
    requiredRankOrder: 3,
  },
  {
    id: 'centurion',
    name: '百夫长战装',
    quality: '紫',
    itemLevel: 62,
    pvpPower: 3,
    costHonor: 260,
    requiredRankOrder: 4,
  },
];

/** 军装单件定义:套装 × 部位展开(id = `${套装id}-${部位}`)。 */
export interface HonorGearItemDef {
  readonly id: string;
  readonly setId: string;
  readonly name: string;
  readonly slot: GearSlot;
  readonly quality: Quality;
  readonly itemLevel: number;
  readonly pvpPower: number;
  readonly costHonor: number;
  readonly requiredRankOrder: number;
}

/** 全件军装表(套装 × 8 部位;兑换裁决在门面,数值只读自这里)。 */
export const HONOR_GEAR: readonly HonorGearItemDef[] = HONOR_GEAR_SETS.flatMap((set) =>
  GEAR_SLOTS.map((slot) => ({
    id: `${set.id}-${slot}`,
    setId: set.id,
    name: `${set.name}·${slot}`,
    slot,
    quality: set.quality,
    itemLevel: set.itemLevel,
    pvpPower: set.pvpPower,
    costHonor: set.costHonor,
    requiredRankOrder: set.requiredRankOrder,
  })),
);

/** 按id查军装单件(门面兑换裁决与 UI 展示共用)。 */
export const HONOR_GEAR_BY_ID: ReadonlyMap<string, HonorGearItemDef> = new Map(
  HONOR_GEAR.map((gear) => [gear.id, gear]),
);
