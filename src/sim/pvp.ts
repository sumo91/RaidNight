/**
 * PvP 活动(T16,GLOSSARY:战场/荣誉阶梯):
 * 战场 = 分梯度的组队 PvP 活动 —— 满职能小队编入战场队(2–3 支)进驻某梯度
 * 战场,自动层逐日结算;胜负皆产出荣誉点(可花费,军装兑换)与生涯荣誉
 * (只增不减,军衔段位由此派生)。
 *
 * 成败复用统一结算引擎(sim/encounter.ts,不另起炉灶):战场队战力 =
 * (有效装等均值 + 职能分×小队数封顶) × (1 + 光环合计%)。军装的战场向属性
 * (pvpPower)只在此处计入有效装等 —— PvE 结算(下本/团本)看不见它。
 * 一切可调数值在 content/pvp.ts(数据驱动);纯函数、只走注入的种子随机链
 * (每场一次成败掷点,顺序固定)。
 * 演出级别(DESIGN「三级演出」):战场 = 结果卡 + 短日志(与 5 人本同级)。
 */

import {
  BATTLEGROUNDS,
  BATTLEFIELD_BY_ID,
  HONOR_RANKS,
  HONOR_RANK_COUNT,
  PVP_SETTLEMENT,
  type BattlefieldDef,
} from '../content/pvp';
import { LEVELING } from '../content/maps';
import type { Role } from '../content/classes';
import { composeSquad, memberRole } from './comp';
import { squadDungeonReadiness } from './dungeon';
import { assessEncounter, rollEncounterOutcome } from './encounter';
import { evaluateUnlockGates } from './ladder';
import { averageItemLevel, guildAverageItemLevel, guildAverageLevel } from './roster';
import type { BattlefieldReport, HonorLedger, Member, Squad } from './state';

/** 战场解锁状态:按内容表顺序,标注当前是否可选与未达标门槛(内容阶梯引擎)。 */
export interface BattlefieldStatus {
  readonly def: BattlefieldDef;
  readonly unlocked: boolean;
  /** 未达标门槛描述(空数组 = 已解锁;与 5 人本同一文案,UI 锁定与测试断言共用)。 */
  readonly unmet: readonly string[];
}

/** 全部战场的解锁状态(派生量:随公会平均等级与平均装等即时变化)。 */
export function battlefieldStatuses(members: readonly Member[]): readonly BattlefieldStatus[] {
  const metrics = { averageLevel: guildAverageLevel(members), averageItemLevel: guildAverageItemLevel(members) };
  return BATTLEGROUNDS.map((def) => {
    const evaluation = evaluateUnlockGates(def.unlock, metrics);
    return { def, unlocked: evaluation.unlocked, unmet: evaluation.unmet };
  });
}

/** 小队当前进驻的战场(活动缺失或战场不在内容表时为 undefined = 休整)。 */
export function squadBattlefield(squad: Squad): BattlefieldDef | undefined {
  if (squad.activity?.type !== 'battlefield') {
    return undefined;
  }
  // 防御:内容表裁撤后存档里的旧战场 id 视同休整(不炸模拟)
  return BATTLEFIELD_BY_ID.get(squad.activity.battlefieldId);
}

/** 一座战场已编入的小队数(战场队规模;编入上限裁决与 UI 展示共用同一式)。 */
export function battlefieldSquadCount(squads: readonly Squad[], battlefieldId: string): number {
  return squads.filter((squad) => squadBattlefield(squad)?.id === battlefieldId).length;
}

/** 团员的战场向属性合计:身上军装逐件的 pvpPower 之和(战场结算专用刻度)。 */
export function pvpPowerOf(member: Member): number {
  return member.gear.reduce((sum, gear) => sum + (gear.pvpPower ?? 0), 0);
}

/** 团员的有效战场装等:装等 + 战场向属性(军装价值的可观察面)。 */
export function battlefieldItemLevel(member: Member): number {
  return averageItemLevel(member) + pvpPowerOf(member);
}

/** 战场队出战摘要:2–3 支小队的战力三要素聚合(统一结算引擎的输入)。 */
export interface BattlefieldTeamSummary {
  /** 出战团员(按小队顺序、队内顺序解析成实体)。 */
  readonly members: readonly Member[];
  /** 出战小队数(职能封顶缩放系数)。 */
  readonly squadCount: number;
  readonly teamSize: number;
  /** 有效装等均值(含军装战场向属性)。 */
  readonly averageItemLevel: number;
  /** 职能结构:全队坦克/治疗/输出计数。 */
  readonly roleCounts: Readonly<Record<Role, number>>;
  /** 光环加成:各小队光环合计的平均百分比(小队光环只在队内生效)。 */
  readonly auraBonusPercent: number;
  /** 军装战场向属性合计(全队逐人求和;报告可观察面)。 */
  readonly pvpPowerTotal: number;
}

/**
 * 解析战场队的出战阵容与战力三要素(队伍 = 已通过进本门槛复核的小队列表;
 * 与 sim/raid.raidTeam 同式的聚合,差别在职能封顶按小队数缩放、装等含战场向属性)。
 */
export function battlefieldTeam(members: readonly Member[], teamSquads: readonly Squad[]): BattlefieldTeamSummary {
  const memberById = new Map(members.map((member) => [member.id, member]));
  const team: Member[] = [];
  const roleCounts: Record<Role, number> = { 坦克: 0, 治疗: 0, 输出: 0 };
  let auraTotal = 0;
  for (const squad of teamSquads) {
    const squadMembers = squad.memberIds
      .map((id) => memberById.get(id))
      .filter((member): member is Member => member !== undefined);
    // 序号在此聚合中无意义(日志与结果卡的序号由结算层携带),占位 0
    const composition = composeSquad(squad, 0, squadMembers);
    for (const member of squadMembers) {
      team.push(member);
      const role = memberRole(member);
      if (role !== undefined) {
        roleCounts[role] += 1;
      }
    }
    auraTotal +=
      composition.auraBonus['伤害'] + composition.auraBonus['生存'] + composition.auraBonus['治疗'];
  }
  const effectiveItemLevel =
    team.length === 0
      ? 0
      : team.reduce((sum, member) => sum + battlefieldItemLevel(member), 0) / team.length;
  return {
    members: team,
    squadCount: teamSquads.length,
    teamSize: team.length,
    averageItemLevel: effectiveItemLevel,
    roleCounts,
    auraBonusPercent: teamSquads.length === 0 ? 0 : auraTotal / teamSquads.length,
    pvpPowerTotal: team.reduce((sum, member) => sum + pvpPowerOf(member), 0),
  };
}

// ———— 荣誉阶梯(军衔)派生量:与声望阶位同一式,门槛在内容表 ————

/** 生涯荣誉 → 军衔阶(0..HONOR_RANK_COUNT;负数按 0,超出按满阶封顶)。 */
export function honorRankRung(careerHonor: number): number {
  const value = Math.max(0, Math.floor(careerHonor));
  let rung = 0;
  for (let r = 1; r < HONOR_RANKS.length; r++) {
    if (value >= HONOR_RANKS[r]!.threshold) {
      rung = r;
    } else {
      break;
    }
  }
  return rung;
}

/** 军衔阶 → 定义(越界钳制在两端;军衔名与门槛来自内容表)。 */
export function honorRankOf(rung: number): (typeof HONOR_RANKS)[number] {
  const clamped = Math.max(0, Math.min(HONOR_RANK_COUNT - 1, Math.floor(rung)));
  return HONOR_RANKS[clamped]!;
}

/** 下一阶军衔(满阶为 undefined;晋升进度条与兑换门槛提示共用)。 */
export function nextHonorRank(rung: number): (typeof HONOR_RANKS)[number] | undefined {
  const next = Math.floor(rung) + 1;
  return next >= HONOR_RANK_COUNT ? undefined : HONOR_RANKS[next]!;
}

/** 战场队成员:小队与其编成序号(结算日志与结果卡的出战小队标示)。 */
interface TeamSquad {
  readonly squad: Squad;
  /** 第几小队(1 起,按编成顺序)。 */
  readonly ordinal: number;
}

/** 逐日结算入参。emit 把短日志文本交回门面(带时刻与序号入事件流)。 */
export interface SettleBattlefieldDayParams {
  readonly members: readonly Member[];
  readonly squads: readonly Squad[];
  /** 荣誉账本(本结算只做加法:胜负荣誉同时进 points 与 career)。 */
  readonly honor: HonorLedger;
  readonly rngState: number;
  /** 本结算日边界(结果卡与日志的时刻)。 */
  readonly atGameMinutes: number;
  readonly emit: (text: string) => void;
}

export interface SettleBattlefieldDayResult {
  readonly members: readonly Member[];
  readonly honor: HonorLedger;
  readonly rngState: number;
  /** 本日最后一场战场的结果卡数据(无任何战场进行时为 undefined)。 */
  readonly lastReport?: BattlefieldReport;
}

/**
 * 结算一个游戏日的战场活动(自动层,确定性):
 * 按编成顺序归拢同战场的战场队(每座战场一队)→ 进本门槛逐队逐日复核
 * (人手不齐的小队离队休整,其余照打)→ 每场:战力评估(不掷点)→ 成败掷点
 * → 胜负荣誉进账 + 全员积劳与士气浮动。无战场进行时不消费随机链。
 * 军衔晋升不在本函数内:门面拿结算后的荣誉账本按门槛推导(与首杀入墙同一编排)。
 */
export function settleBattlefieldDay(params: SettleBattlefieldDayParams): SettleBattlefieldDayResult {
  const { atGameMinutes, emit } = params;
  let rngState = params.rngState;
  let members = params.members;
  let points = params.honor.points;
  let career = params.honor.career;
  let lastReport: BattlefieldReport | undefined;

  // 归拢战场队:按小队编成顺序,首支进驻某战场的小队开创该战场队
  const teams = new Map<string, { def: BattlefieldDef; squads: TeamSquad[] }>();
  for (const [index, squad] of params.squads.entries()) {
    const def = squadBattlefield(squad);
    if (def === undefined) {
      continue;
    }
    const team = teams.get(def.id) ?? { def, squads: [] };
    team.squads.push({ squad, ordinal: index + 1 });
    teams.set(def.id, team);
  }

  for (const { def, squads: teamSquads } of teams.values()) {
    // 门槛复核:淘汰/调离导致人手不齐的小队今日缺席(每日一条,可观察)
    const readySquads: Squad[] = [];
    const ordinals: number[] = [];
    for (const { squad, ordinal } of teamSquads) {
      const readiness = squadDungeonReadiness(squad, members);
      if (!readiness.ready) {
        emit(`第 ${ordinal} 小队缺席「${def.name}」今日之战:${readiness.reasons.join('、')},补齐编成后自动归队。`);
        continue;
      }
      readySquads.push(squad);
      ordinals.push(ordinal);
    }
    if (readySquads.length === 0) {
      continue; // 全队缺席:今日弃权,不消费随机链
    }

    const team = battlefieldTeam(members, readySquads);
    const teamIds = new Set(team.members.map((member) => member.id));

    for (let battle = 1; battle <= def.battlesPerDay; battle++) {
      // 战力评估(不掷点)+ 成败掷点(唯一随机点):职能封顶按小队数缩放
      const assessment = assessEncounter(
        {
          averageItemLevel: team.averageItemLevel,
          roleCounts: team.roleCounts,
          auraBonusPercent: team.auraBonusPercent,
        },
        def.difficultyTarget,
        { roleCapScale: team.squadCount },
      );
      const [victory, afterRoll] = rollEncounterOutcome(rngState, assessment.successChance);
      rngState = afterRoll;

      const honorGained = victory ? def.honorPerWin : def.honorPerLoss;
      points += honorGained;
      career += honorGained;

      // 全员积劳 + 士气浮动(胜场小涨、败场小跌;钳制 0-100)
      const fatigue = def.fatiguePerBattle;
      const moodDelta = victory ? PVP_SETTLEMENT.victoryMoodBoost : -PVP_SETTLEMENT.defeatMoodHit;
      members = members.map((member) =>
        teamIds.has(member.id)
          ? {
              ...member,
              fatigue: Math.min(LEVELING.maxFatigue, member.fatigue + fatigue),
              mood: Math.max(0, Math.min(100, member.mood + moodDelta)),
            }
          : member,
      );

      const chancePercent = Math.round(assessment.successChance * 100);
      const teamLabel = `第 ${ordinals.join('、')} 小队(${team.teamSize} 人)`;
      emit(
        victory
          ? `「${def.name}」第 ${battle} 场告捷:${teamLabel} 战力 ${Math.round(assessment.power)} 对敌方 ${assessment.target}(胜率 ${chancePercent}%),荣誉 +${def.honorPerWin}。`
          : `「${def.name}」第 ${battle} 场失利:${teamLabel} 战力 ${Math.round(assessment.power)} 对敌方 ${assessment.target}(胜率 ${chancePercent}%),安慰荣誉 +${def.honorPerLoss}。`,
      );

      lastReport = {
        battlefieldId: def.id,
        battlefieldName: def.name,
        gradient: def.gradient,
        atGameMinutes,
        victory,
        power: assessment.power,
        target: assessment.target,
        successChance: assessment.successChance,
        band: assessment.band,
        squadOrdinals: ordinals,
        teamSize: team.teamSize,
        pvpPowerTotal: team.pvpPowerTotal,
        honorGained,
        members: team.members.map((member) => ({
          name: member.name,
          role: memberRole(member) ?? '?',
          itemLevel: battlefieldItemLevel(member),
        })),
      };
    }
  }

  return { members, honor: { points, career }, rngState, lastReport };
}
