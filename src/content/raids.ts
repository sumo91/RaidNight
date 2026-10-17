/**
 * 团本表与团本结算数值配置(数据驱动内容)。
 *
 * 规则逻辑在 src/sim/raid.ts(整夜结算)与统一结算引擎 src/sim/encounter.ts;
 * 团队检查门槛在 content/comp.ts;一切可调数值(首领难度、硬门槛、掉落、
 * 团灭代价)都在这里,调优不动模拟代码。
 * 命名遵循 ADR-0002:团本名与首领名一律原创,擦边致敬对照表只在开发文档
 * (docs/naming.md),不进游戏。
 * GLOSSARY:团本 = 最高规模的组织性 PvE 活动,按难度分档(tier);
 * 团队 = 最多 8 小队(40 人)的出战阵容;开荒 = 反复挑战尚未通关的内容。
 * 团本 CD = 游戏周(DESIGN):每周边界一个团本夜,按首领顺序逐个结算。
 * 新增团本 = 追加一条数据(档位递增、门槛不越过阶梯),不需要改任何代码。
 */

import type { DropQualityRule, DungeonUnlockGates } from './dungeons';

/** 团本首领定义。 */
export interface RaidBossDef {
  readonly id: string;
  readonly name: string;
  /** 一句话头衔(UI 展示)。 */
  readonly title: string;
  /**
   * 难度目标(战力刻度,与 5 人本同一结算引擎):团队战力与它比较,
   * 低于(目标 − failMargin)必败、高于(目标 + winMargin)必胜、之间线性。
   */
  readonly difficultyTarget: number;
  /**
   * 装等硬门槛:全团平均装等低于此值 ⇒ 必败(无论战力)。
   * 设置了该字段的首领即「硬门槛首领」—— 装备不达标,打法再好也过不去。
   */
  readonly hardGateItemLevel?: number;
  /** 击杀后掉落的装备件数。 */
  readonly dropsPerKill: number;
  /** 掉落装等基准(品质加成与扰动另计)。 */
  readonly dropItemLevel: number;
}

/** 团本定义(40 人团队活动,DESIGN:4 档主力团本之一)。 */
export interface RaidDef {
  readonly id: string;
  readonly name: string;
  /** 一句话风情描述(UI 展示)。 */
  readonly description: string;
  /** 难度档(1 起;GLOSSARY:按难度分档)。 */
  readonly tier: number;
  /** 解锁门槛:公会平均等级 + 公会平均装等(双维,与 5 人本同一判定)。 */
  readonly unlock: DungeonUnlockGates;
  /** 首领表:团本夜按此顺序逐个结算(不许跳级)。 */
  readonly bosses: readonly RaidBossDef[];
}

/**
 * 首批团本:第 1 档 40 人团本(DESIGN 全量 4 档主力 + 2 个 20 人休闲团本,
 * 后续工单在此扩表)。首领按顺序 5 名:前两名是门面,第三名设装等硬门槛
 * (刚达团本门槛的团队会在此团灭,回 5 人本提装等再战 = 开荒节奏)。
 */
export const RAIDS: readonly RaidDef[] = [
  {
    id: 'molten-abyss',
    name: '熔渊窟',
    description:
      '山根底下熔岩凿出的窟城,元素大军在此操练了千年,就等一个四十人的借口。',
    tier: 1,
    unlock: { averageLevel: 55, averageItemLevel: 62 },
    bosses: [
      {
        id: 'stone-throat-warden',
        name: '石喉守卫',
        title: '窟门处永远醒着的活体石像',
        difficultyTarget: 100,
        dropsPerKill: 3,
        dropItemLevel: 74,
      },
      {
        id: 'searing-chain-hound',
        name: '焚链魔犬',
        title: '烧红的锁链拴了三代驯犬人',
        difficultyTarget: 106,
        dropsPerKill: 3,
        dropItemLevel: 74,
      },
      {
        id: 'ash-archon',
        name: '灰烬执政官',
        title: '硬门槛:没有足够的装等,连它的灰都碰不到',
        difficultyTarget: 108,
        hardGateItemLevel: 68,
        dropsPerKill: 3,
        dropItemLevel: 76,
      },
      {
        id: 'molten-scale-hydra',
        name: '熔鳞多头蛇',
        title: '每一颗头都记仇,而且都喷火',
        difficultyTarget: 112,
        dropsPerKill: 3,
        dropItemLevel: 76,
      },
      {
        id: 'molten-lord-malgar',
        name: '烬渊之主玛尔加恩',
        title: '窟城的心脏,熔渊本身的心思',
        difficultyTarget: 116,
        dropsPerKill: 4,
        dropItemLevel: 78,
      },
    ],
  },
];

/** 按 id 查团本(sim 结算与 UI 展示共用)。 */
export const RAID_BY_ID: ReadonlyMap<string, RaidDef> = new Map(
  RAIDS.map((raid) => [raid.id, raid]),
);

/** 团本掉落品质权重(第 1 档:不掉白装,紫装两成半;后续档在此逐档抬升)。 */
export const RAID_DROP_QUALITY: readonly DropQualityRule[] = [
  { quality: '白', weight: 0 },
  { quality: '绿', weight: 20 },
  { quality: '蓝', weight: 55 },
  { quality: '紫', weight: 25 },
];

/** 团本结算可调数值(公式与流程在 sim/raid.ts)。 */
export interface RaidSettlementConfig {
  /** 每次首领战(无论成败)每名团员的疲劳积累。 */
  readonly attemptFatiguePerBoss: number;
  /** 团灭修理金:每名团员(从公会金库扣除,余额不足按余额封顶)。 */
  readonly wipeRepairGoldPerRaider: number;
  /** 团灭额外疲劳(在 attemptFatiguePerBoss 之上)。 */
  readonly wipeFatigue: number;
  /** 团灭士气(心情)打击。 */
  readonly wipeMoodHit: number;
  /** 全通士气(心情)提升。 */
  readonly clearMoodBoost: number;
  /** 掉落装等扰动幅度(±)。 */
  readonly dropJitter: number;
  /** 击杀首领时最多倒下的团人数(演出用:险胜倒得多,碾压倒得少)。 */
  readonly killFallenCap: number;
}

export const RAID_SETTLEMENT: RaidSettlementConfig = {
  attemptFatiguePerBoss: 8,
  wipeRepairGoldPerRaider: 3,
  wipeFatigue: 12,
  wipeMoodHit: 10,
  clearMoodBoost: 8,
  dropJitter: 1,
  killFallenCap: 6,
};
