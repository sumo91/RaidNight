/**
 * 统一结算引擎(DESIGN.md「活动结算」):成败 = 装等 / 职能 / 光环 三要素的战力
 * 对副本难度目标的三段式比较 —— 低配必败、超配必胜、中间线性概率分布。
 *
 * 本模块是纯函数引擎,不做任何随机消费(掷点见 rollEncounterOutcome)与状态更新;
 * 5 人本(src/sim/dungeon.ts)是第一个接入方,后续野团 / G团 / 团本复用同一引擎。
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

/** 结算评估:纯计算、不掷点。 */
export interface EncounterAssessment {
  /** 队伍战力:(平均装等 + 职能分) × (1 + 光环合计%) */
  readonly power: number;
  readonly target: number;
  /** 成功概率(三段式:0、(0,1) 线性、1) */
  readonly successChance: number;
  readonly band: EncounterBand;
}

/** 职能结构分:坦克/治疗/输出各自计入(封顶件数在内容表)。 */
export function roleScore(roleCounts: Readonly<Record<Role, number>>): number {
  const config = DUNGEON_SETTLEMENT.roleScore;
  return (
    Math.min(roleCounts['坦克'], config.tankCap) * config.perTank +
    Math.min(roleCounts['治疗'], config.healerCap) * config.perHealer +
    Math.min(roleCounts['输出'], config.dpsCap) * config.perDps
  );
}

/** 队伍战力:(平均装等 + 职能分) × (1 + 光环合计%)。 */
export function encounterPower(input: EncounterPowerInput): number {
  return (input.averageItemLevel + roleScore(input.roleCounts)) * (1 + input.auraBonusPercent / 100);
}

/**
 * 三段式评估:战力 ≤ 目标 − failMargin 必败(概率 0);
 * ≥ 目标 + winMargin 必胜(概率 1);之间线性过渡(悬念区间)。
 */
export function assessEncounter(input: EncounterPowerInput, target: number): EncounterAssessment {
  const power = encounterPower(input);
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
