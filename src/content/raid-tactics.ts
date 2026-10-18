/**
 * 开荒决策面内容表(数据驱动内容,T14)。
 *
 * DESIGN「开荒决策面」:团本夜前三个赛前决策 —— 消耗品预算(金库拨款买药水
 * 合剂)、世界 Buff(花游戏时间与金币的时效增益)、编成微调(职能配比与光环
 * 取舍),全部影响当夜结算,赛中只观赛。
 * 规则逻辑在 src/sim/raid.ts(整夜结算的就绪判定与生效)与门面(指令裁决);
 * 一切可调数值(拨款额、增益幅度、筹备时长、阵形系数)都在这里,调优不动模拟代码。
 * 命名遵循 ADR-0002:专有名词一律原创,不使用既有 IP 专名。
 * GLOSSARY:开荒 = 反复挑战尚未通关的内容;团本 CD = 游戏周,决策随开团安排
 * 存在、当夜结算后随安排清空(下周重新开团、重新决策)。
 */

import type { Role } from './classes';

/** 消耗品预算档位 id(金库拨款买药水合剂;GLOSSARY:公会金库用于消耗品)。 */
export type ConsumableTierId = 'frugal' | 'standard' | 'lavish';

/** 消耗品预算档:拨款额换当夜全团战力增益(买定离手:换档再全额拨款、此前不退)。 */
export interface ConsumableTierDef {
  readonly id: ConsumableTierId;
  /** 档位名(UI 展示)。 */
  readonly name: string;
  /** 一句话风格(UI 展示)。 */
  readonly tagline: string;
  /** 金库拨款额(设定指令时从公会金库一次性扣除)。 */
  readonly costGold: number;
  /** 当夜全团战力增益 %(统一结算引擎的最终乘区)。 */
  readonly powerBonusPercent: number;
}

/** 消耗品预算三档:量入为出 —— 拨多少款,打多硬的仗。 */
export const CONSUMABLE_TIERS: readonly ConsumableTierDef[] = [
  {
    id: 'frugal',
    name: '省着用',
    tagline: '药水分着喝,合剂留给出勤最稳的几桌。',
    costGold: 60,
    powerBonusPercent: 4,
  },
  {
    id: 'standard',
    name: '标配采买',
    tagline: '人手一套药水合剂,开荒夜的体面。',
    costGold: 150,
    powerBonusPercent: 8,
  },
  {
    id: 'lavish',
    name: '全力开荒',
    tagline: '合剂当水喝,药剂师笑得合不拢嘴。',
    costGold: 300,
    powerBonusPercent: 14,
  },
];

/** 按档位 id 查定义(sim 结算与 UI 展示共用)。 */
export const CONSUMABLE_TIER_BY_ID: ReadonlyMap<ConsumableTierId, ConsumableTierDef> = new Map(
  CONSUMABLE_TIERS.map((tier) => [tier.id, tier]),
);

/** 世界 Buff id(DESIGN:花游戏时间与金币的时效增益;命名原创,ADR-0002)。 */
export type WorldBuffId = 'war-drums' | 'moonwell-blessing' | 'dragon-hymn';

/** 世界 Buff:拨款 + 筹备时长的时效增益,只对筹备完成后的那个团本夜生效。 */
export interface WorldBuffDef {
  readonly id: WorldBuffId;
  /** Buff 名(UI 展示)。 */
  readonly name: string;
  /** 一句话风情描述(UI 展示)。 */
  readonly description: string;
  /** 金库拨款额(启用指令时从公会金库一次性扣除,无论是否来得及都不退)。 */
  readonly costGold: number;
  /**
   * 筹备时长(游戏日):启用时刻距团本夜不足此数 ⇒ 未及备妥,当夜无效
   * (游戏时间成本 —— 要拿世界 Buff,就得在开周边界后尽早启程)。
   */
  readonly prepGameDays: number;
  /** 备妥后当夜全团战力增益 %(与消耗品增益叠加)。 */
  readonly powerBonusPercent: number;
}

/** 世界 Buff 三种:越强的越贵也越慢 —— 早做准备是决策的一部分。 */
export const WORLD_BUFFS: readonly WorldBuffDef[] = [
  {
    id: 'war-drums',
    name: '战鼓余音',
    description: '昨夜庆功的战鼓还没停,余音推着人往前冲。',
    costGold: 60,
    prepGameDays: 1,
    powerBonusPercent: 3,
  },
  {
    id: 'moonwell-blessing',
    name: '月井祝福',
    description: '连夜把全团拉去月井边沐手,泉水凉得人一激灵。',
    costGold: 140,
    prepGameDays: 3,
    powerBonusPercent: 6,
  },
  {
    id: 'dragon-hymn',
    name: '龙裔战歌',
    description: '请游吟诗人把屠龙的旧诗从头唱到尾,唱完天都亮了。',
    costGold: 260,
    prepGameDays: 5,
    powerBonusPercent: 10,
  },
];

/** 按 id 查定义(sim 结算与 UI 展示共用)。 */
export const WORLD_BUFF_BY_ID: ReadonlyMap<WorldBuffId, WorldBuffDef> = new Map(
  WORLD_BUFFS.map((buff) => [buff.id, buff]),
);

/** 编成微调阵形 id(DESIGN:职能配比与光环取舍)。 */
export type RaidStanceId = 'balanced' | 'spearhead' | 'bulwark' | 'aura-weave';

/** 阵形:当夜结算的取舍系数 —— 有得必有失,没有全赢的阵。 */
export interface RaidStanceDef {
  readonly id: RaidStanceId;
  /** 阵形名(UI 展示)。 */
  readonly name: string;
  /** 一句话取舍说明(UI 展示与事件文案共用)。 */
  readonly tagline: string;
  /** 一句话风情描述(UI 展示)。 */
  readonly description: string;
  /** 职能分系数:乘在封顶后的分项上(缺省 1;职能配比取舍)。 */
  readonly roleMultipliers: Readonly<Partial<Record<Role, number>>>;
  /** 光环覆盖系数:乘在小队光环合计百分比上(缺省 1;光环取舍)。 */
  readonly auraMultiplier: number;
}

/** 四种阵形:锋矢换输出、铁壁换生存、串联换光环 —— 各吃各的编成。 */
export const RAID_STANCES: readonly RaidStanceDef[] = [
  {
    id: 'balanced',
    name: '常规阵形',
    tagline: '各司其职,教科书打法。',
    description: '不折腾:坦克顶住、治疗看好、输出打满,一切按操典来。',
    roleMultipliers: {},
    auraMultiplier: 1,
  },
  {
    id: 'spearhead',
    name: '锋矢突进',
    tagline: '压缩治疗、押上输出,把每个冷却都打进狂暴计时器。',
    description: '治疗职能分 −40%、输出职能分 +35%:输出去向的取舍,治疗富裕的编成才压得起。',
    roleMultipliers: { '治疗': 0.6, '输出': 1.35 },
    auraMultiplier: 1,
  },
  {
    id: 'bulwark',
    name: '铁壁龟阵',
    tagline: '坦克与治疗加深,输出让位 —— 活着才有输出。',
    description: '坦克职能分 +30%、治疗 +25%、输出 −25%:坦奶加深的编成把战线焊死,打得慢但死不了。',
    roleMultipliers: { '坦克': 1.3, '治疗': 1.25, '输出': 0.75 },
    auraMultiplier: 1,
  },
  {
    id: 'aura-weave',
    name: '光环串联',
    tagline: '全团按光环重新落位,职能分工让一点,团队协同涨一截。',
    description: '光环覆盖 ×1.6、职能分整体 −15%:职业越杂、光环越满的编成,串联收益越大。',
    roleMultipliers: { '坦克': 0.85, '治疗': 0.85, '输出': 0.85 },
    auraMultiplier: 1.6,
  },
];

/** 按阵形 id 查定义(sim 结算与 UI 展示共用)。 */
export const RAID_STANCE_BY_ID: ReadonlyMap<RaidStanceId, RaidStanceDef> = new Map(
  RAID_STANCES.map((stance) => [stance.id, stance]),
);

/** 缺省阵形:常规(未微调时的基线)。 */
export const DEFAULT_RAID_STANCE: RaidStanceId = 'balanced';
