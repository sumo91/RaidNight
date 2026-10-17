/**
 * 技艺评级档位表(数据驱动内容)。
 * 评级 = 团员的操作水平画像;对活动结算的影响见后续工单。
 */

export interface SkillTierDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** 生成期抽取权重 */
  readonly weight: number;
}

export const SKILL_TIERS: readonly SkillTierDef[] = [
  { id: 'top', name: '天梯常客', description: '操作与意识俱佳,稀缺资源。', weight: 2 },
  { id: 'expert', name: '高玩', description: '关键时刻靠得住。', weight: 8 },
  { id: 'skilled', name: '熟手', description: '稳定发挥,偶有高光。', weight: 22 },
  { id: 'casual', name: '普通', description: '中规中矩,需要好指挥。', weight: 46 },
  { id: 'rookie', name: '萌新', description: '潜力股,需要人带。', weight: 22 },
];

export const SKILL_TIER_BY_ID: ReadonlyMap<string, SkillTierDef> = new Map(
  SKILL_TIERS.map((tier) => [tier.id, tier]),
);
