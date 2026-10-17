import type { Member } from './state';

/**
 * 名册派生量:由状态直接计算、不引入新随机的展示/结算用数值。
 * 规则只存在于 sim,UI 只调用不实现。
 */

/** 装等摘要:8 部位装备装等的四舍五入平均值(无装备时为 0)。 */
export function averageItemLevel(member: Member): number {
  if (member.gear.length === 0) {
    return 0;
  }
  const total = member.gear.reduce((sum, item) => sum + item.itemLevel, 0);
  return Math.round(total / member.gear.length);
}
