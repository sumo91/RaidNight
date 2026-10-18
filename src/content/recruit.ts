/**
 * 招募配置(数据驱动内容):申请池规格与名册上限。
 *
 * 规则逻辑在 src/sim/recruit.ts;一切可调数值都在这里,调优不动模拟代码。
 * 申请池「依据声望每日刷新」(GLOSSARY):数量与质量均由声望阶位(rung,
 * 0..21,7 档 × 3 星,见 content/reputation.ts)驱动 —— T12 起为真值,
 * 不再有桩值(T3 时代的 stubReputation 已移除)。
 */

import type { Range } from './roster-gen';

export interface RecruitConfig {
  /**
   * 名册起步上限:会长角色 + 5 名初始团员 = 6 人小会。
   * GLOSSARY:名册上限随声望与大厅成长;声望侧联动 = content/reputation 的
   * 档位加成(sim/reputation.rosterCapForRung),大厅建设属后续工单。
   */
  readonly baseRosterCap: number;
  /**
   * 申请池的职能保底(T18):每日刷新的池子里至少一名坦克职能与一名治疗职能
   * —— 满职能小队是一切活动的前提,池子长期不出坦/奶会让组建无从谈起
   * (确定性:不足时把首份申请的职业与专精改写为保底项,不追加随机)。
   */
  readonly poolRoleGuarantee: {
    readonly tank: { readonly classId: string; readonly specId: string };
    readonly healer: { readonly classId: string; readonly specId: string };
  };
  /** 申请池数量参数(阶位驱动)。 */
  readonly poolCount: {
    /** 基础份数(0 阶「无名小会」时每日的申请数)。 */
    readonly baseCount: number;
    /** 份数上限。 */
    readonly maxCount: number;
    /** 每升 rungsPerExtraApplicant 个阶位,每日申请 +1 份。 */
    readonly rungsPerExtraApplicant: number;
  };
  /** 申请池质量参数:阶位越高,苗子等级越高、技艺越好。 */
  readonly poolQuality: {
    /** 申请人等级基础区间(与建会名册同级;随版本进度联动见后续工单)。 */
    readonly baseLevelRange: Range;
    /** 每升 rungsPerLevelBonus 个阶位,等级区间整体上移 1 级。 */
    readonly rungsPerLevelBonus: number;
    /** 等级上移上限(防止早期声望涌入拉爆等级曲线)。 */
    readonly levelBonusCap: number;
    /**
     * 技艺档偏置(乘数,满阶 21 时生效):
     * 实际权重 = 档位基础权重 × (1 + 阶位比例 × (偏置 - 1)),偏置 1 = 不变。
     * 高技艺档偏置 >1 更常见、低技艺档偏置 <1 更少见;线性插值保持确定性。
     */
    readonly skillTierBias: readonly { readonly tierId: string; readonly bias: number }[];
  };
}

export const RECRUIT: RecruitConfig = {
  baseRosterCap: 6,
  poolRoleGuarantee: {
    tank: { classId: 'warrior', specId: 'warrior-guard' },
    healer: { classId: 'priest', specId: 'priest-light' },
  },
  poolCount: {
    baseCount: 3,
    maxCount: 8,
    rungsPerExtraApplicant: 3,
  },
  poolQuality: {
    baseLevelRange: [8, 11],
    rungsPerLevelBonus: 2,
    levelBonusCap: 21,
    skillTierBias: [
      { tierId: 'top', bias: 3.0 },
      { tierId: 'expert', bias: 1.8 },
      { tierId: 'skilled', bias: 1.0 },
      { tierId: 'casual', bias: 0.7 },
      { tierId: 'rookie', bias: 0.4 },
    ],
  },
};
