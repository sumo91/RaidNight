/**
 * 装备部位与品质表(数据驱动内容)。
 * 8 部位、4 品质(白/绿/蓝/紫),装等驱动(DESIGN.md「装备」);
 * 具体物品表(物品名与词条)见后续装备工单,当前生成「部位 + 品质 + 装等」。
 */

/** 8 个装备部位(固定顺序 = 详情页展示顺序)。 */
export const GEAR_SLOTS = ['头', '肩', '胸', '腕', '手', '腰', '腿', '脚'] as const;

export type GearSlot = (typeof GEAR_SLOTS)[number];

/** 装备品质(白/绿/蓝/紫)。 */
export type Quality = '白' | '绿' | '蓝' | '紫';

export interface QualityRule {
  readonly quality: Quality;
  /** 生成期品质抽取权重 */
  readonly weight: number;
  /** 品质带来的装等加成 */
  readonly itemLevelBonus: number;
}

/** 品质规则表:权重与装等加成可调。 */
export const QUALITY_RULES: readonly QualityRule[] = [
  { quality: '白', weight: 55, itemLevelBonus: 0 },
  { quality: '绿', weight: 33, itemLevelBonus: 1 },
  { quality: '蓝', weight: 10, itemLevelBonus: 2 },
  { quality: '紫', weight: 2, itemLevelBonus: 3 },
];
