/**
 * 建会名册生成配置(数据驱动内容)。
 *
 * 生成规则本身(抽取顺序、装等公式)在 src/sim/member-gen.ts;
 * 一切可调数值(人数、等级区间、三维初始区间、会长角色参数)都在这里,
 * 调整配置不需要动模拟代码 —— 「同一种子生成同一批团员」对配置敏感、对代码稳定。
 */

/** 闭区间数值范围。 */
export type Range = readonly [number, number];

export interface RosterGenConfig {
  /** 建会时随会长入册的团员数(不含会长角色);6 人小会 = 会长 + 5。 */
  readonly foundingMemberCount: number;
  /** 会长角色的生成参数。 */
  readonly chairman: {
    readonly level: number;
    readonly moodRange: Range;
    readonly fatigueRange: Range;
    /** 会长角色固定出勤风格(他必然到场) */
    readonly attendanceStyleId: 'iron';
    readonly attendanceRateRange: Range;
  };
  /** 普通团员的生成参数。 */
  readonly member: {
    readonly levelRange: Range;
    readonly moodRange: Range;
    readonly loyaltyRange: Range;
    readonly fatigueRange: Range;
  };
  /** 性格标签个数抽取权重(1–2 个)。 */
  readonly traitCountWeights: readonly { readonly count: number; readonly weight: number }[];
  /** 同批团员名字去重的最大重试次数(组合空间大,几乎不会用尽)。 */
  readonly nameUniqueAttempts: number;
  /** 装等随机扰动幅度(±itemLevelJitter)。 */
  readonly itemLevelJitter: number;
}

export const ROSTER_GEN: RosterGenConfig = {
  foundingMemberCount: 5,
  chairman: {
    level: 12,
    moodRange: [70, 90],
    fatigueRange: [0, 10],
    attendanceStyleId: 'iron',
    attendanceRateRange: [95, 99],
  },
  member: {
    levelRange: [8, 11],
    moodRange: [60, 90],
    loyaltyRange: [50, 80],
    fatigueRange: [0, 20],
  },
  traitCountWeights: [
    { count: 1, weight: 55 },
    { count: 2, weight: 45 },
  ],
  nameUniqueAttempts: 8,
  itemLevelJitter: 1,
};
