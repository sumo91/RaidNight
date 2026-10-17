/**
 * 招募配置(数据驱动内容):申请池规格与名册上限。
 *
 * 规则逻辑在 src/sim/recruit.ts;一切可调数值都在这里,调优不动模拟代码。
 * 申请池「依据声望每日刷新」(GLOSSARY):数量与质量均由声望驱动;
 * 本票声望为桩值(stubReputation,T12 接声望系统真值)。
 */

import type { Range } from './roster-gen';

export interface RecruitConfig {
  /**
   * 桩值声望(0-100):新建公会是无名小会,从 0 起步;
   * T12 由声望系统(7 档 × 3 星)驱动真值,本票只作为池子规格的输入。
   */
  readonly stubReputation: number;
  /** 声望刻度上限(0-100)。 */
  readonly reputationMax: number;
  /**
   * 名册起步上限:会长角色 + 5 名初始团员 = 6 人小会。
   * (GLOSSARY:名册上限随声望与大厅成长;扩容联动在 T12。)
   */
  readonly baseRosterCap: number;
  /** 申请池数量参数。 */
  readonly poolCount: {
    /** 基础份数(声望为 0 时每日的申请数)。 */
    readonly baseCount: number;
    /** 份数上限。 */
    readonly maxCount: number;
    /** 每 countBonusPerReputation 点声望,每日申请 +1 份。 */
    readonly countBonusPerReputation: number;
  };
  /** 申请池质量参数:声望越高,苗子等级越高、技艺越好。 */
  readonly poolQuality: {
    /** 申请人等级基础区间(与建会名册同级;随版本进度联动见后续工单)。 */
    readonly baseLevelRange: Range;
    /** 每 levelBonusPerReputation 点声望,等级区间整体上移 1 级。 */
    readonly levelBonusPerReputation: number;
    /** 等级上移上限(防止早期声望涌入拉爆等级曲线)。 */
    readonly levelBonusCap: number;
    /**
     * 技艺档偏置(乘数,声望满值时生效):
     * 实际权重 = 档位基础权重 × (1 + 声望比例 × (偏置 - 1)),偏置 1 = 不变。
     * 高技艺档偏置 >1 更常见、低技艺档偏置 <1 更少见;线性插值保持确定性。
     */
    readonly skillTierBias: readonly { readonly tierId: string; readonly bias: number }[];
  };
}

export const RECRUIT: RecruitConfig = {
  stubReputation: 0,
  reputationMax: 100,
  baseRosterCap: 6,
  poolCount: {
    baseCount: 3,
    maxCount: 8,
    countBonusPerReputation: 20,
  },
  poolQuality: {
    baseLevelRange: [8, 11],
    levelBonusPerReputation: 25,
    levelBonusCap: 4,
    skillTierBias: [
      { tierId: 'top', bias: 3.0 },
      { tierId: 'expert', bias: 1.8 },
      { tierId: 'skilled', bias: 1.0 },
      { tierId: 'casual', bias: 0.7 },
      { tierId: 'rookie', bias: 0.4 },
    ],
  },
};
