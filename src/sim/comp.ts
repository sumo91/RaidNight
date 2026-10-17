/**
 * 编成派生量:由状态直接计算、不引入新随机的规则数值(职能结构、小队光环、团队检查)。
 * 规则只存在于 sim,UI 只调用不实现;一切可调门槛在 content/comp.ts(数据驱动)。
 */

import { AURA_BY_CLASS, COMP, type AuraDef, type AuraStat } from '../content/comp';
import { CLASS_BY_ID, type Role } from '../content/classes';
import type { GameState, Member, MemberProfile, Squad } from './state';

/** 团员的职能:由职业 + 专精查表得出(数据驱动)。 */
export function memberRole(profile: MemberProfile): Role | undefined {
  return CLASS_BY_ID.get(profile.classId)?.specs.find((spec) => spec.id === profile.specId)?.role;
}

/** 小队职能缺口:缺什么职能(或未满员)、缺几个;编成页据此实时标示。 */
export interface SquadGap {
  readonly kind: Role | '满员';
  readonly missing: number;
}

/** 生效中的小队光环(GLOSSARY:特定职业在小队内为全队提供的被动加成)。 */
export interface ActiveAura {
  readonly def: AuraDef;
  /** 提供者姓名(同职业多人共存:光环只算一次,提供者全部列出) */
  readonly providers: readonly string[];
}

/** 光环加成预览:三类加成各自合计的百分比(同职业不叠加、不同职业相加)。 */
export type AuraBonus = Readonly<Record<AuraStat, number>>;

/** 小队编成摘要:一支小队的全部派生量。 */
export interface SquadComposition {
  readonly squad: Squad;
  /** 第几小队(1 起,按编成顺序) */
  readonly ordinal: number;
  /** 队内团员(按编入顺序解析成实体;引用不存在的 id 会被跳过) */
  readonly members: readonly Member[];
  readonly roleCounts: Readonly<Record<Role, number>>;
  readonly gaps: readonly SquadGap[];
  readonly auras: readonly ActiveAura[];
  readonly auraBonus: AuraBonus;
}

/** 逐队计算编成摘要(职能结构 / 缺口 / 光环预览)。 */
export function squadCompositions(state: GameState): readonly SquadComposition[] {
  const memberById = new Map(state.members.map((member) => [member.id, member]));

  return state.squads.map((squad, index) =>
    composeSquad(squad, index + 1, squad.memberIds
      .map((id) => memberById.get(id))
      .filter((member): member is Member => member !== undefined)),
  );
}

/**
 * 计算一支小队的编成摘要(队内成员已解析):职能结构 / 缺口 / 光环预览。
 * 编成页与活动结算(下本战力)共用;引用不存在的团员 id 会被跳过。
 */
export function composeSquad(
  squad: Squad,
  ordinal: number,
  members: readonly Member[],
): SquadComposition {
  // 职能结构:坦克/治疗/输出计数
  const roleCounts: Record<Role, number> = { 坦克: 0, 治疗: 0, 输出: 0 };
  for (const member of members) {
    const role = memberRole(member);
    if (role !== undefined) {
      roleCounts[role] += 1;
    }
  }

  // 缺口:对照小队职能结构与满员要求
  const gaps: SquadGap[] = [];
  const missingTanks = Math.max(0, COMP.squadStructure.minTanks - roleCounts['坦克']);
  if (missingTanks > 0) {
    gaps.push({ kind: '坦克', missing: missingTanks });
  }
  const missingHealers = Math.max(0, COMP.squadStructure.minHealers - roleCounts['治疗']);
  if (missingHealers > 0) {
    gaps.push({ kind: '治疗', missing: missingHealers });
  }
  const missingMembers = Math.max(0, COMP.squadSize - members.length);
  if (missingMembers > 0) {
    gaps.push({ kind: '满员', missing: missingMembers });
  }

  // 小队光环:按职业去重(同职业不叠加),不同职业加成相加
  const providersByClass = new Map<string, Member[]>();
  for (const member of members) {
    const list = providersByClass.get(member.classId) ?? [];
    list.push(member);
    providersByClass.set(member.classId, list);
  }
  const auras: ActiveAura[] = [];
  const auraBonus: Record<AuraStat, number> = { 伤害: 0, 生存: 0, 治疗: 0 };
  for (const [classId, providers] of providersByClass) {
    const def = AURA_BY_CLASS.get(classId);
    if (def === undefined) {
      continue;
    }
    auras.push({ def, providers: providers.map((member) => member.name) });
    auraBonus[def.stat] += def.percent;
  }

  return { squad, ordinal, members, roleCounts, gaps, auras, auraBonus };
}

/** 待命团员:名册中不在任何小队的成员。 */
export function unassignedMembers(state: GameState): readonly Member[] {
  const assigned = new Set(state.squads.flatMap((squad) => squad.memberIds));
  return state.members.filter((member) => !assigned.has(member.id));
}

/** 团队检查的总量汇总(DESIGN:总坦克数、总治疗数、职能覆盖)。 */
export interface TeamCheckTotals {
  /** 小队总数 */
  readonly squads: number;
  /** 满员小队数(5/5) */
  readonly fullSquads: number;
  /** 在编人数(各小队人数之和) */
  readonly assigned: number;
  readonly tanks: number;
  readonly healers: number;
  readonly dps: number;
}

/** 团队检查未通过的一项(结构化:kind 供 UI 分类,text 供直接展示)。 */
export interface TeamCheckFailure {
  readonly kind: '满编' | '总坦克' | '总治疗' | '职能覆盖';
  readonly text: string;
}

export interface TeamCheckResult {
  readonly passed: boolean;
  readonly totals: TeamCheckTotals;
  readonly failures: readonly TeamCheckFailure[];
}

/**
 * 团队检查(GLOSSARY:团队 = 最多 8 小队的团本出战阵容):
 * 满员小队数、总坦克、总治疗达到门槛,且每支小队至少 1 坦 1 奶(职能覆盖)。
 */
export function teamCheck(state: GameState): TeamCheckResult {
  const compositions = squadCompositions(state);
  const totals: TeamCheckTotals = {
    squads: compositions.length,
    fullSquads: compositions.filter((c) => c.members.length >= COMP.squadSize).length,
    assigned: compositions.reduce((sum, c) => sum + c.members.length, 0),
    tanks: compositions.reduce((sum, c) => sum + c.roleCounts['坦克'], 0),
    healers: compositions.reduce((sum, c) => sum + c.roleCounts['治疗'], 0),
    dps: compositions.reduce((sum, c) => sum + c.roleCounts['输出'], 0),
  };

  const failures: TeamCheckFailure[] = [];
  if (totals.fullSquads < COMP.teamCheck.requiredFullSquads) {
    failures.push({
      kind: '满编',
      text: `满员小队不足:${totals.fullSquads}/${COMP.teamCheck.requiredFullSquads} 支`,
    });
  }
  if (totals.tanks < COMP.teamCheck.minTanks) {
    failures.push({ kind: '总坦克', text: `总坦克不足:${totals.tanks}/${COMP.teamCheck.minTanks}` });
  }
  if (totals.healers < COMP.teamCheck.minHealers) {
    failures.push({
      kind: '总治疗',
      text: `总治疗不足:${totals.healers}/${COMP.teamCheck.minHealers}`,
    });
  }
  for (const composition of compositions) {
    const roleGaps = composition.gaps.filter((gap) => gap.kind === '坦克' || gap.kind === '治疗');
    if (roleGaps.length > 0) {
      failures.push({
        kind: '职能覆盖',
        text: `第 ${composition.ordinal} 小队${roleGaps.map((gap) => `缺${gap.kind}×${gap.missing}`).join('、')}`,
      });
    }
  }

  return { passed: failures.length === 0, totals, failures };
}
