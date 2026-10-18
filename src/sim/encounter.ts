/**
 * 统一结算引擎(DESIGN.md「活动结算」):成败 = 装等 / 职能 / 光环 三要素的战力
 * 对副本难度目标的三段式比较 —— 低配必败、超配必胜、中间线性概率分布。
 *
 * 本模块是纯函数引擎,不做任何随机消费(掷点见 rollEncounterOutcome)与状态更新;
 * 5 人本(src/sim/dungeon.ts)是第一个接入方,团本(sim/raid.ts)复用同一引擎
 * —— 团本夜可附带「结算修正量」(T14 开荒决策面:阵形系数与药水合剂增益),
 * 修正量全部缺省时行为与基础引擎完全一致(5 人本不传即不受影响)。
 * 一切可调数值在 content/dungeons.ts(数据驱动)。
 */

import { DUNGEON_SETTLEMENT } from '../content/dungeons';
import type { Role } from '../content/classes';
import { nextFloat } from './rng';

/** 三段式区间名(结果卡与短日志展示用)。 */
export type EncounterBand = '必败' | '悬念' | '必胜';

/** 战力输入:一支小队(或团队)的三要素摘要。 */
export interface EncounterPowerInput {
  /** 平均装等(成员装等均值的刻度) */
  readonly averageItemLevel: number;
  /** 职能结构:坦克/治疗/输出计数 */
  readonly roleCounts: Readonly<Record<Role, number>>;
  /** 小队光环加成合计百分比(伤害+生存+治疗,同职业不叠加) */
  readonly auraBonusPercent: number;
}

/**
 * 结算修正量(T14 开荒决策面):对三要素战力的可选修饰。
 * 四者全部缺省 ⇒ 战力公式与基础引擎逐字相同。
 */
export interface EncounterModifiers {
  /** 职能分系数:乘在封顶后的分项上(缺省 1;编成微调阵形的职能配比取舍)。 */
  readonly roleMultipliers?: Readonly<Partial<Record<Role, number>>>;
  /** 光环覆盖系数:乘在光环合计百分比上(缺省 1;阵形的光环取舍)。 */
  readonly auraMultiplier?: number;
  /** 额外战力增益合计百分比:乘在最终战力上(缺省 0;消耗品与世界 Buff)。 */
  readonly bonusPowerPercent?: number;
  /**
   * 职能分封顶件数的缩放系数(缺省 1;T16 战场按出战小队数放大 ——
   * 战场队是 2–3 小队的聚合体,更大的队伍职能件数更多;5 人本与团本不传,
   * 封顶与基础引擎一致)。
   */
  readonly roleCapScale?: number;
}

/** 结算评估:纯计算、不掷点。 */
export interface EncounterAssessment {
  /** 队伍战力:(平均装等 + 职能分) × (1 + 光环合计%) × (1 + 增益合计%) */
  readonly power: number;
  readonly target: number;
  /** 成功概率(三段式:0、(0,1) 线性、1) */
  readonly successChance: number;
  readonly band: EncounterBand;
}

/** 职能结构分:坦克/治疗/输出各自计入(封顶件数在内容表;分项可被阵形系数缩放)。 */
export function roleScore(
  roleCounts: Readonly<Record<Role, number>>,
  modifiers?: EncounterModifiers,
): number {
  const config = DUNGEON_SETTLEMENT.roleScore;
  const mult = (role: Role): number => modifiers?.roleMultipliers?.[role] ?? 1;
  // 封顶缩放(缺省 1):战场聚合队按小队数放大封顶件数,其余活动不传即原样
  const scale = modifiers?.roleCapScale ?? 1;
  return (
    Math.min(roleCounts['坦克'], config.tankCap * scale) * config.perTank * mult('坦克') +
    Math.min(roleCounts['治疗'], config.healerCap * scale) * config.perHealer * mult('治疗') +
    Math.min(roleCounts['输出'], config.dpsCap * scale) * config.perDps * mult('输出')
  );
}

/** 队伍战力:(平均装等 + 职能分) × (1 + 光环合计% × 光环系数) × (1 + 增益合计%)。 */
export function encounterPower(
  input: EncounterPowerInput,
  modifiers?: EncounterModifiers,
): number {
  const aura = input.auraBonusPercent * (modifiers?.auraMultiplier ?? 1);
  const bonus = modifiers?.bonusPowerPercent ?? 0;
  return (input.averageItemLevel + roleScore(input.roleCounts, modifiers)) * (1 + aura / 100) * (1 + bonus / 100);
}

/**
 * 三段式评估:战力 ≤ 目标 − failMargin 必败(概率 0);
 * ≥ 目标 + winMargin 必胜(概率 1);之间线性过渡(悬念区间)。
 */
export function assessEncounter(
  input: EncounterPowerInput,
  target: number,
  modifiers?: EncounterModifiers,
): EncounterAssessment {
  const power = encounterPower(input, modifiers);
  const lower = target - DUNGEON_SETTLEMENT.failMargin;
  const upper = target + DUNGEON_SETTLEMENT.winMargin;
  const successChance = Math.max(0, Math.min(1, (power - lower) / (upper - lower)));
  const band: EncounterBand =
    successChance <= 0 ? '必败' : successChance >= 1 ? '必胜' : '悬念';
  return { power, target, successChance, band };
}

/** 掷点定成败:一次均匀随机对成功概率的比较(唯一随机点)。 */
export function rollEncounterOutcome(rngState: number, successChance: number): [success: boolean, nextState: number] {
  const [roll, nextState] = nextFloat(rngState);
  return [roll < successChance, nextState];
}
