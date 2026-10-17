import { RECRUIT } from '../content/recruit';
import { SKILL_TIERS, type SkillTierDef } from '../content/skill-tiers';
import type { Range } from '../content/roster-gen';
import { generateMemberProfile } from './member-gen';
import type { Applicant, Member } from './state';

/**
 * 招募:申请池的规格推导与整池生成(GLOSSARY:申请池,依据声望每日刷新)。
 * 数值参数全部来自 src/content/recruit.ts(数据驱动);
 * 声望本票为桩值,T12 接声望系统真值 —— 本模块只依赖传入的声望数值。
 */

/** 申请池规格:声望驱动的数量与质量。 */
export interface ApplicantPoolSpec {
  /** 当日申请份数 */
  readonly count: number;
  /** 申请人等级区间 */
  readonly levelRange: Range;
  /** 技艺档抽取表(声望重加权后的权重) */
  readonly skillTiers: readonly SkillTierDef[];
}

/**
 * 声望 → 申请池规格(纯函数):
 * 数量 = 基础份数 + 每 countBonusPerReputation 点声望 +1(有上限);
 * 质量 = 等级区间上移 + 技艺档权重向高技艺倾斜(线性插值,确定性)。
 */
export function poolSpecForReputation(reputation: number): ApplicantPoolSpec {
  const rep = Math.max(0, Math.min(RECRUIT.reputationMax, Math.floor(reputation)));

  const count = Math.min(
    RECRUIT.poolCount.maxCount,
    RECRUIT.poolCount.baseCount + Math.floor(rep / RECRUIT.poolCount.countBonusPerReputation),
  );

  const offset = Math.min(
    RECRUIT.poolQuality.levelBonusCap,
    Math.floor(rep / RECRUIT.poolQuality.levelBonusPerReputation),
  );
  const [lo, hi] = RECRUIT.poolQuality.baseLevelRange;
  const levelRange: Range = [lo + offset, hi + offset];

  const ratio = rep / RECRUIT.reputationMax;
  const biasById = new Map(RECRUIT.poolQuality.skillTierBias.map((entry) => [entry.tierId, entry.bias]));
  const skillTiers: SkillTierDef[] = SKILL_TIERS.map((tier) => {
    const bias = biasById.get(tier.id) ?? 1;
    return { ...tier, weight: tier.weight * (1 + ratio * (bias - 1)) };
  });

  return { count, levelRange, skillTiers };
}

/** 整池生成结果:新申请池 + 生成结束后的随机链状态 + 下一个申请编号。 */
export interface ApplicantPoolResult {
  readonly applicants: readonly Applicant[];
  readonly rngState: number;
  readonly nextApplicationId: number;
}

/**
 * 生成一整池申请(每日刷新与建会初始池共用):
 * 按规格份数逐份生成画像,姓名与在册团员及同批去重;
 * 全程消费并传递随机链状态 —— 同种子 + 同声望 ⇒ 同一池申请。
 */
export function generateApplicantPool(
  rngState: number,
  reputation: number,
  rosterMembers: readonly Member[],
  startApplicationId: number,
): ApplicantPoolResult {
  const spec = poolSpecForReputation(reputation);
  const usedNames = new Set(rosterMembers.map((member) => member.name));
  const applicants: Applicant[] = [];
  let rng = rngState;

  for (let i = 0; i < spec.count; i++) {
    const [profile, nextRng] = generateMemberProfile(rng, {
      isChairman: false, // 申请人不可能是会长角色
      usedNames,
      levelRange: spec.levelRange,
      skillTiers: spec.skillTiers,
    });
    rng = nextRng;
    applicants.push({ applicationId: startApplicationId + i, profile });
    usedNames.add(profile.name);
  }

  return { applicants, rngState: rng, nextApplicationId: startApplicationId + applicants.length };
}
