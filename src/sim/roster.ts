import { RAIDS } from '../content/raids';
import type { MemberProfile } from './state';

/**
 * 名册派生量:由状态直接计算、不引入新随机的展示/结算用数值。
 * 规则只存在于 sim,UI 只调用不实现。
 */

/** 装等摘要:8 部位装备装等的四舍五入平均值(无装备时为 0)。在册团员与申请人通用。 */
export function averageItemLevel(profile: MemberProfile): number {
  if (profile.gear.length === 0) {
    return 0;
  }
  const total = profile.gear.reduce((sum, item) => sum + item.itemLevel, 0);
  return Math.round(total / profile.gear.length);
}

/**
 * 全部 tier 套装定义的查表(内容表汇总;按 setId 索引)。
 * 套装规则(GLOSSARY/DESIGN:团本 tier 出 5 件套,2/5 件效果)只有这一处真源。
 */
const SET_BY_ID = new Map(
  RAIDS.flatMap((raid) => (raid.set === undefined ? [] : [[raid.set.id, raid.set] as const])),
);

/** 一名团员身上各套装的已穿件数(按 setId 聚合;非套装件不计)。 */
export function setPieceCounts(profile: MemberProfile): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of profile.gear) {
    if (item.setId !== undefined) {
      counts.set(item.setId, (counts.get(item.setId) ?? 0) + 1);
    }
  }
  return counts;
}

/** 已起效的套装(穿满 2 件起效;取件数最多的一套,2/5 之外无更高档)。 */
export function activeSet(profile: MemberProfile): { readonly id: string; readonly name: string; readonly pieces: number } | undefined {
  let best: { id: string; name: string; pieces: number } | undefined;
  for (const [id, pieces] of setPieceCounts(profile)) {
    if (pieces < 2) {
      continue; // 2 件起效:单件不成套
    }
    const def = SET_BY_ID.get(id);
    if (def === undefined) {
      continue; // 套装已从内容表裁撤:不生效(防御旧档)
    }
    if (best === undefined || pieces > best.pieces) {
      best = { id, name: def.name, pieces };
    }
  }
  return best;
}

/**
 * 套装加成(2/5 件效果):已起效套装的结算装等加成;无起效套装为 0。
 * 只在结算侧生效(5 人本/团本战力与硬门槛),不进入解锁门槛的
 * 公会平均装等 —— 套装帮你打首领,不替你解锁内容。
 */
export function setBonusItemLevel(profile: MemberProfile): number {
  const active = activeSet(profile);
  if (active === undefined) {
    return 0;
  }
  return SET_BY_ID.get(active.id)?.setBonusItemLevel ?? 0;
}

/**
 * 结算装等 = 展示装等 + 套装加成(统一结算引擎的装等刻度):
 * 5 人本小队战力、团本团队战力与装等硬门槛都用它(装备追赶的一环);
 * UI 名册与解锁门槛仍用 averageItemLevel(原始值)。
 */
export function effectiveItemLevel(profile: MemberProfile): number {
  return averageItemLevel(profile) + setBonusItemLevel(profile);
}

/** 公会平均等级:名册全员(含会长角色)等级的向下取整均值;空名册为 0。练级地图的解锁刻度。 */
export function guildAverageLevel(members: readonly MemberProfile[]): number {
  if (members.length === 0) {
    return 0;
  }
  const total = members.reduce((sum, member) => sum + member.level, 0);
  return Math.floor(total / members.length);
}

/** 公会平均装等:名册全员装等均值的向下取整;空名册为 0。5 人本难度档的解锁刻度之一。 */
export function guildAverageItemLevel(members: readonly MemberProfile[]): number {
  if (members.length === 0) {
    return 0;
  }
  const total = members.reduce((sum, member) => sum + averageItemLevel(member), 0);
  return Math.floor(total / members.length);
}
