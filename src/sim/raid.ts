/**
 * 团本夜活动:团本的整夜结算(T10 起步,T18 全量:40 人主力 + 20 人休闲 + G团接单)。
 *
 * 成败走统一结算引擎(sim/encounter.ts,与 5 人本同一套):
 * 团队战力 = (全团平均结算装等 + 职能分) × (1 + 各小队光环合计的平均%);
 * 结算装等含 tier 套装加成(2/5 件效果,T18,DESIGN「装备」);
 * 首领可设「装等硬门槛」—— 全团平均结算装等不达标 ⇒ 必败,无论战力。
 * 团队检查按团本规模折算(sim/comp.teamCheckOf):20 人本只带前 4 支满员小队。
 * 一切可调数值在 content/raids.ts(数据驱动);纯函数、只走注入的种子随机链
 * (每首领一次成败掷点 → 胜利掉落抽取,顺序固定)。
 *
 * G团接单(T18,GLOSSARY:G团 = 以金币结算装备归属的团本形式):
 * 开团安排带 mode: 'gRun' 且团本开放接单(20 人休闲团本)时,掉落整批
 * 卖给随团买家 —— 成交价金库抽成 + 出战团员均分打工费(个人金);
 * 不走分配制度、不记 DKP、不适用制度心态(打工性质)。
 *
 * 开荒决策面(T14,DESIGN):开团安排可携带三项赛前决策 —— 消耗品预算
 * (content/raid-tactics 的拨款档)、世界 Buff(启用时刻距团本夜足额筹备才生效)、
 * 编成微调阵形(职能分与光环覆盖的取舍系数)—— 经结算修正量进入当夜每个
 * 首领的战力评估;决策随安排在夜末清空(时效 = 当夜)。
 *
 * 演出级别(DESIGN「三级演出」):团本 = 直播视图 —— 结算产出结构化
 * RaidNightReport(首领血条、团队点阵、滚动战斗日志的数据面)与逐条文本
 * (经门面入事件流);赛前决策(开团/编成/预算/Buff/阵形)在赛前完成,
 * 赛中只观赛不可介入。
 * 团灭代价 = 修理金(公会金库,余额封顶)+ 疲劳 + 士气(心情),无永久损失:
 * 名册不动、忠诚不动、装备不丢,下个团本夜再战(开荒)。
 */

import {
  G_RUN,
  RAID_BY_ID,
  RAID_DROP_QUALITY,
  RAID_SETTLEMENT,
  RAIDS,
  type RaidDef,
} from '../content/raids';
import type { WeeklyGoalDef } from '../content/plan';
import {
  CONSUMABLE_TIER_BY_ID,
  DEFAULT_RAID_STANCE,
  RAID_STANCES,
  RAID_STANCE_BY_ID,
  WORLD_BUFF_BY_ID,
  type ConsumableTierId,
  type RaidStanceId,
  type WorldBuffDef,
  type WorldBuffId,
} from '../content/raid-tactics';
import { LOOT_SYSTEM_BY_ID } from '../content/economy';
import { LEVELING } from '../content/maps';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK } from './clock';
import type { Role } from '../content/classes';
import { composeSquad, memberRole, teamCheckOf } from './comp';
import { rollDropItems } from './dungeon';
import {
  applyLootSystemNightEffects,
  accrueDkpOnKill,
  distributeRaidDrop,
} from './economy';
import { assessEncounter, encounterPower, type EncounterModifiers } from './encounter';
import { evaluateUnlockGates } from './ladder';
import { averageItemLevel, effectiveItemLevel, guildAverageItemLevel, guildAverageLevel } from './roster';
import { nextFloat } from './rng';
import type {
  DropOutcome,
  GameState,
  GuildEconomy,
  GuildVault,
  Member,
  RaidBossOutcome,
  RaidNightReport,
  RaidPlan,
  Squad,
} from './state';

/** 团本解锁状态:按内容表顺序,标注当前是否可选与未达标门槛(内容阶梯引擎)。 */
export interface RaidStatus {
  readonly def: RaidDef;
  readonly unlocked: boolean;
  /** 未达标门槛描述(空数组 = 已解锁;与 5 人本同一文案,UI 锁定与测试断言共用)。 */
  readonly unmet: readonly string[];
}

/** 全部团本的解锁状态(派生量:随公会平均等级与平均装等即时变化)。 */
export function raidStatuses(members: readonly Member[]): readonly RaidStatus[] {
  const metrics = { averageLevel: guildAverageLevel(members), averageItemLevel: guildAverageItemLevel(members) };
  return RAIDS.map((def) => {
    const evaluation = evaluateUnlockGates(def.unlock, metrics);
    return { def, unlocked: evaluation.unlocked, unmet: evaluation.unmet };
  });
}

/** 团队出战摘要:团队(40 人 = 8 小队 / 20 人 = 4 小队)的战力三要素聚合(统一结算引擎的输入)。 */
export interface RaidTeamSummary {
  /** 出战团员(按小队顺序、队内顺序解析成实体)。 */
  readonly members: readonly Member[];
  readonly teamSize: number;
  /** 全团平均结算装等(含套装加成;硬门槛与战力的装等刻度)。 */
  readonly averageItemLevel: number;
  /** 职能结构:全团坦克/治疗/输出计数(职能分由引擎按封顶计入)。 */
  readonly roleCounts: Readonly<Record<Role, number>>;
  /** 光环加成:各小队光环合计(伤害+生存+治疗)的平均百分比
   *  —— 小队光环只在队内生效(GLOSSARY),全团取平均即「光环覆盖度」。 */
  readonly auraBonusPercent: number;
}

/**
 * 解析团队的出战阵容与战力三要素(团队检查通过时 = size/5 支满员小队)。
 * 20 人休闲团本只带编成顺序的前 4 支小队(T18);结算装等含套装加成
 * (2/5 件效果,DESIGN「装备」)。
 */
export function raidTeam(
  members: readonly Member[],
  squads: readonly Squad[],
  size: 20 | 40 = 40,
): RaidTeamSummary {
  const memberById = new Map(members.map((member) => [member.id, member]));
  const team: Member[] = [];
  const roleCounts: Record<Role, number> = { 坦克: 0, 治疗: 0, 输出: 0 };
  let auraTotal = 0;
  const raiding = squads.slice(0, Math.round(size / 5));
  for (const [index, squad] of raiding.entries()) {
    const squadMembers = squad.memberIds
      .map((id) => memberById.get(id))
      .filter((member): member is Member => member !== undefined);
    const composition = composeSquad(squad, index + 1, squadMembers);
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
  const teamItemLevel =
    team.length === 0
      ? 0
      : team.reduce((sum, member) => sum + effectiveItemLevel(member), 0) / team.length;
  return {
    members: team,
    teamSize: team.length,
    averageItemLevel: teamItemLevel,
    roleCounts,
    auraBonusPercent: raiding.length === 0 ? 0 : auraTotal / raiding.length,
  };
}

// ———— 开荒决策面(T14):就绪判定与派生量(结算、门面与 UI 共用同一式)————

/**
 * 世界 Buff 就绪判定(唯一真源):启用时刻距团本夜的筹备时长须足额。
 * 启用得晚于筹备窗 ⇒ 未及备妥,当夜无效(拨款已在启用时花掉,不退)。
 */
export function worldBuffReady(
  def: WorldBuffDef,
  armedAtGameMinutes: number,
  nightAtGameMinutes: number,
): boolean {
  return nightAtGameMinutes - armedAtGameMinutes >= def.prepGameDays * GAME_MINUTES_PER_DAY;
}

/** 已投入一个团本夜的赛前采购金合计(消耗品 + 已启用世界 Buff;取消安排时的浪费提示)。 */
export function tacticsInvestmentGold(plan: RaidPlan): number {
  const tactics = plan.tactics;
  if (tactics === undefined) {
    return 0;
  }
  const consumable =
    tactics.consumableTier !== undefined
      ? CONSUMABLE_TIER_BY_ID.get(tactics.consumableTier)?.costGold ?? 0
      : 0;
  const buffs = (tactics.worldBuffs ?? []).reduce(
    (sum, armed) => sum + (WORLD_BUFF_BY_ID.get(armed.buffId)?.costGold ?? 0),
    0,
  );
  return consumable + buffs;
}

/** 已启用世界 Buff的就绪视图(UI 决策面板渲染;就绪判定与团本夜结算同一式)。 */
export interface ArmedWorldBuffView {
  readonly def: WorldBuffDef;
  readonly armedAtGameMinutes: number;
  /** 距团本夜(下一个游戏周边界)的筹备时长(游戏分钟)。 */
  readonly leadGameMinutes: number;
  /** 就绪 = 筹备时长已足额(距夜不足 ⇒ 来不及,当夜无效)。 */
  readonly readyByNight: boolean;
}

/** 逐项列出开团安排上已启用的世界 Buff 及其就绪状态(纯派生量,不改状态)。 */
export function armedWorldBuffs(state: GameState): readonly ArmedWorldBuffView[] {
  const plan = state.raidPlan;
  if (plan === undefined) {
    return [];
  }
  const nightAt =
    (Math.floor(state.clockGameMinutes / GAME_MINUTES_PER_WEEK) + 1) * GAME_MINUTES_PER_WEEK;
  return (plan.tactics?.worldBuffs ?? []).flatMap((armed) => {
    const def = WORLD_BUFF_BY_ID.get(armed.buffId);
    if (def === undefined) {
      return []; // Buff 已从内容表裁撤:不展示(结算同样跳过)
    }
    return [
      {
        def,
        armedAtGameMinutes: armed.armedAtGameMinutes,
        leadGameMinutes: Math.max(0, nightAt - armed.armedAtGameMinutes),
        readyByNight: worldBuffReady(def, armed.armedAtGameMinutes, nightAt),
      },
    ];
  });
}

/** 阵形战力预览条目:同一团队在各阵形下的战力(编成微调的取舍可见)。 */
export interface StancePowerPreview {
  readonly stanceId: string;
  readonly name: string;
  /** 该阵形下的团队战力(统一结算引擎,不带消耗品/Buff 增益)。 */
  readonly power: number;
}

/** 各阵形下的团队战力预览(基线 = 常规阵形;UI 与测试共用,纯派生量)。 */
export function stancePowerPreviews(
  members: readonly Member[],
  squads: readonly Squad[],
): readonly StancePowerPreview[] {
  const team = raidTeam(members, squads);
  const base = {
    averageItemLevel: team.averageItemLevel,
    roleCounts: team.roleCounts,
    auraBonusPercent: team.auraBonusPercent,
  };
  return RAID_STANCES.map((def) => ({
    stanceId: def.id,
    name: def.name,
    power: encounterPower(base, {
      roleMultipliers: def.roleMultipliers,
      auraMultiplier: def.auraMultiplier,
    }),
  }));
}

/** 夜内结算用的决策解析:阵形、消耗品、逐项就绪的世界 Buff(内容表裁撤防御)。 */
interface ResolvedTactics {
  readonly stanceId: RaidStanceId;
  readonly stanceName: string;
  readonly stanceNotDefault: boolean;
  readonly consumable?: { readonly id: ConsumableTierId; readonly name: string; readonly bonusPercent: number; readonly goldSpent: number };
  readonly worldBuffs: readonly {
    readonly id: WorldBuffId;
    readonly name: string;
    readonly ready: boolean;
    readonly bonusPercent: number;
    readonly goldSpent: number;
    readonly prepGameDays: number;
    readonly leadDays: number;
  }[];
  /** 消耗品 + 就绪世界 Buff 的增益合计 %(阵形是取舍,不计入)。 */
  readonly bonusPowerPercent: number;
  /** 是否做了任何一项决策(报告快照与事件行只在做决策时出现)。 */
  readonly any: boolean;
}

/** 解析开团安排上的赛前决策(不掷随机、不改状态;团本夜结算与取消提示共用)。 */
function resolveTactics(plan: RaidPlan, atGameMinutes: number): ResolvedTactics {
  const tactics = plan.tactics;
  const stance =
    (tactics?.stance !== undefined ? RAID_STANCE_BY_ID.get(tactics.stance) : undefined) ??
    RAID_STANCE_BY_ID.get(DEFAULT_RAID_STANCE)!;
  const consumableDef =
    tactics?.consumableTier !== undefined
      ? CONSUMABLE_TIER_BY_ID.get(tactics.consumableTier)
      : undefined;
  const worldBuffs = (tactics?.worldBuffs ?? []).flatMap((armed) => {
    const def = WORLD_BUFF_BY_ID.get(armed.buffId);
    if (def === undefined) {
      return [];
    }
    const ready = worldBuffReady(def, armed.armedAtGameMinutes, atGameMinutes);
    return [
      {
        id: def.id,
        name: def.name,
        ready,
        bonusPercent: ready ? def.powerBonusPercent : 0,
        goldSpent: def.costGold,
        prepGameDays: def.prepGameDays,
        leadDays: (atGameMinutes - armed.armedAtGameMinutes) / GAME_MINUTES_PER_DAY,
      },
    ];
  });
  const bonusPowerPercent =
    (consumableDef?.powerBonusPercent ?? 0) +
    worldBuffs.reduce((sum, buff) => sum + buff.bonusPercent, 0);
  return {
    stanceId: stance.id,
    stanceName: stance.name,
    stanceNotDefault: stance.id !== DEFAULT_RAID_STANCE,
    consumable:
      consumableDef === undefined
        ? undefined
        : {
            id: consumableDef.id,
            name: consumableDef.name,
            bonusPercent: consumableDef.powerBonusPercent,
            goldSpent: consumableDef.costGold,
          },
    worldBuffs,
    bonusPowerPercent,
    any:
      consumableDef !== undefined ||
      worldBuffs.length > 0 ||
      (tactics?.stance !== undefined && tactics.stance !== DEFAULT_RAID_STANCE),
  };
}

/** 整夜结算入参。emit 把战斗日志文本交回门面(带时刻与序号入事件流)。 */
export interface SettleRaidNightParams {
  readonly members: readonly Member[];
  readonly squads: readonly Squad[];
  readonly vault: GuildVault;
  /** 公会经济:现行分配制度与自肥开关(T11;掉落归属按此结算)。 */
  readonly economy: GuildEconomy;
  /** 声望值(T12 真值):自肥的声望代价从这里扣减;首杀/里程碑加分由门面结算。 */
  readonly renownPoints: number;
  readonly plan: RaidPlan;
  readonly rngState: number;
  /** 团本夜时刻(= 游戏周边界;报告与日志的时刻)。 */
  readonly atGameMinutes: number;
  /**
   * 团灭修理金系数(缺省 1):虚拟服务器的抬价波进行中 > 1(T13,竞争公会
   * 扫货 → 修理材料涨价;幅度见 content/world,到期回落 —— 幅度轻、不锁内容)。
   */
  readonly repairCostFactor?: number;
  /**
   * 当周目标(T15,计划层;state.weeklyPlan 的解析结果,自动/手动开团一律适用):
   * 数值钩子见 content/plan —— 夜末出席者心态调整、farm 卖店、带新分配倾斜。
   * 缺省(undefined = 无周计划)= 全部钩子不生效,行为与 T14 完全一致。
   */
  readonly goal?: WeeklyGoalDef;
  readonly emit: (text: string) => void;
}

export interface SettleRaidNightResult {
  readonly members: readonly Member[];
  readonly vault: GuildVault;
  /** 经济面回写:自肥件数与声望代价累积(T11)。 */
  readonly economy: GuildEconomy;
  /** 声望值回写(自肥代价扣减后,下限 0)。 */
  readonly renownPoints: number;
  readonly rngState: number;
  /** 整夜结算的报告(直播视图数据);夜被取消(检查未过/内容失效)时为 undefined。 */
  readonly report?: RaidNightReport;
}

/**
 * 结算一个团本夜(确定性):按首领顺序逐个结算,团灭即止。
 * 流程:开团复核(团队检查 + 内容门槛,不过即取消、不消费随机链)
 * → 逐首领:战力评估(不掷点)→ 硬门槛裁决 → 成败掷点 → 胜利掉落与全团择优穿戴
 * → 每次首领战全员积劳;团灭付出修理金 + 疲劳 + 士气,本夜止步于该首领;
 * 全通则全团士气小涨。夜结束由门面清空开团安排(团本 CD = 游戏周)。
 */
export function settleRaidNight(params: SettleRaidNightParams): SettleRaidNightResult {
  const { squads, vault, plan, atGameMinutes, emit } = params;
  const raid = RAID_BY_ID.get(plan.raidId);
  if (raid === undefined) {
    emit(`团本安排失效:安排的团本已不在团本表中,本周不开团。`);
    return { members: params.members, vault, economy: params.economy, renownPoints: params.renownPoints, rngState: params.rngState };
  }

  // 赛前决策解析(纯计算,不掷随机):夜取消的浪费提示与夜内的战力修正共用
  const tactics = resolveTactics(plan, atGameMinutes);
  const wastedGold = tacticsInvestmentGold(plan);

  // 开团复核①:内容阶梯门槛(开团后名册回落则取消 —— 未达标不可进入)
  const unlock = evaluateUnlockGates(raid.unlock, {
    averageLevel: guildAverageLevel(params.members),
    averageItemLevel: guildAverageItemLevel(params.members),
  });
  if (!unlock.unlocked) {
    emit(`团本夜取消:「${raid.name}」门槛未达(${unlock.unmet.join('、')}),本周不开团。`);
    if (wastedGold > 0) {
      emit(`本周赛前采购 ${wastedGold} 金随夜取消作废 —— 下周重新开团、重新决策。`);
    }
    return { members: params.members, vault, economy: params.economy, renownPoints: params.renownPoints, rngState: params.rngState };
  }

  // 开团复核②:团队检查(按团本规模折算:20 人本 = 前 4 支满员小队;
  // 开团后淘汰/调离导致阵容不齐则取消,不算团灭)
  const check = teamCheckOf(params.members, squads, raid.size);
  if (!check.passed) {
    emit(
      `团本夜取消:团队检查未通过(${check.failures.map((f) => f.text).join('、')}),补齐编成后下周再战。`,
    );
    if (wastedGold > 0) {
      emit(`本周赛前采购 ${wastedGold} 金随夜取消作废 —— 下周重新开团、重新决策。`);
    }
    return { members: params.members, vault, economy: params.economy, renownPoints: params.renownPoints, rngState: params.rngState };
  }

  // 现行分配制度(防御:状态里的制度 id 不在内容表时回落默认裁量);
  // G团接单夜不走分配制度(掉落整批卖给买家),制度心态也不适用(打工性质)
  const gRunNight = plan.mode === 'gRun' && raid.gRunAllowed === true;
  const system = LOOT_SYSTEM_BY_ID.get(params.economy.system) ?? LOOT_SYSTEM_BY_ID.get('chairman')!;

  let rngState = params.rngState;
  let members = params.members;
  let currentVault = vault;
  // 分配结算的整夜累计(自肥件数/声望代价;金库入账由 incomeTotal 差值得出)
  let nightSelfDealt = 0;
  let reputationCostTotal = 0;
  let personalGoldOut = 0;
  // G团接单的整夜累计(T18:卖出件数/金库抽成/每人打工费)
  let gRunDropsSold = 0;
  let gRunVaultGoldIn = 0;
  let gRunGoldPerRaider = 0;

  const team = raidTeam(members, squads, raid.size);
  const teamIds = new Set(team.members.map((member) => member.id));
  /** 出战阵容的团员 id 顺序(分配时按当前名册重新解析,换装结果逐件可见)。 */
  const teamOrderIds = team.members.map((member) => member.id);
  const chancePercent = (value: number) => Math.round(value * 100);

  emit(
    `团本夜开始:「${raid.name}」${gRunNight ? '(G团接单)' : ''}—— ${raid.bosses.length} 名首领按顺序结算,全团 ${team.teamSize} 人,平均装等 ${Math.round(team.averageItemLevel)}。`,
  );

  // 赛前决策生效宣告(T14):阵形与增益逐项可见;未及备妥的世界 Buff 点名作废
  const stanceDef = RAID_STANCE_BY_ID.get(tactics.stanceId) ?? RAID_STANCE_BY_ID.get(DEFAULT_RAID_STANCE)!;
  const nightModifiers: EncounterModifiers = {
    roleMultipliers: stanceDef.roleMultipliers,
    auraMultiplier: stanceDef.auraMultiplier,
    bonusPowerPercent: tactics.bonusPowerPercent,
  };
  if (tactics.any) {
    const parts: string[] = [];
    if (tactics.stanceNotDefault) {
      parts.push(`阵形「${tactics.stanceName}」`);
    }
    if (tactics.consumable !== undefined) {
      parts.push(`消耗品「${tactics.consumable.name}」+${tactics.consumable.bonusPercent}%`);
    }
    for (const buff of tactics.worldBuffs) {
      if (buff.ready) {
        parts.push(`世界Buff「${buff.name}」+${buff.bonusPercent}%`);
      }
    }
    const tail =
      tactics.bonusPowerPercent > 0 ? `当夜战力增益合计 +${tactics.bonusPowerPercent}%` : '无战力增益';
    emit(`赛前决策生效:${parts.length > 0 ? `${parts.join('、')};` : ''}${tail}。`);
    for (const buff of tactics.worldBuffs) {
      if (!buff.ready) {
        emit(
          `世界Buff「${buff.name}」未及备妥(启用距团本夜仅 ${Math.floor(buff.leadDays)} 日,需 ${buff.prepGameDays} 日),本周无效 —— 拨款 ${buff.goldSpent} 金已花。`,
        );
      }
    }
  }

  /** 只更新出战团员(会长角色不在小队则不受团本夜影响)。 */
  const mapTeam = (update: (member: Member) => Member): void => {
    members = members.map((member) => (teamIds.has(member.id) ? update(member) : member));
  };

  const outcomes: RaidBossOutcome[] = [];
  let wiped = false;
  let wipeIndex = 0;

  for (const [index, boss] of raid.bosses.entries()) {
    const ordinal = index + 1;
    // 战力评估(不掷点;T14 赛前决策经结算修正量进入)+ 硬门槛裁决:装等不达标 ⇒ 必败,无论战力
    const assessment = assessEncounter(
      {
        averageItemLevel: team.averageItemLevel,
        roleCounts: team.roleCounts,
        auraBonusPercent: team.auraBonusPercent,
      },
      boss.difficultyTarget,
      nightModifiers,
    );
    const hardGateMet =
      boss.hardGateItemLevel === undefined ||
      team.averageItemLevel >= boss.hardGateItemLevel;
    const successChance = hardGateMet ? assessment.successChance : 0;

    // 成败掷点(唯一随机点;与统一结算引擎同式,保留掷点值供演出推算倒下人数)
    const [roll, afterRoll] = nextFloat(rngState);
    rngState = afterRoll;
    const killed = roll < successChance;

    // 每次首领战(无论成败)全员积劳
    mapTeam((member) => ({
      ...member,
      fatigue: Math.min(LEVELING.maxFatigue, member.fatigue + RAID_SETTLEMENT.attemptFatiguePerBoss),
    }));

    let drops: readonly DropOutcome[] = [];
    let fallen: number;
    if (killed) {
      // 险胜程度 → 倒下人数(碾压 = 0,擦线 = 上限;演出数据,不另消费随机)
      const escape = successChance > 0 ? (successChance - roll) / successChance : 1;
      fallen = Math.min(
        RAID_SETTLEMENT.killFallenCap,
        Math.round((1 - escape) * RAID_SETTLEMENT.killFallenCap),
      );
      emit(
        `「${boss.name}」被击杀:战力 ${Math.round(assessment.power)} 对难度 ${assessment.target}(胜率 ${chancePercent(successChance)}%)${fallen > 0 ? `,${fallen} 人倒下又被拉起` : ''}。`,
      );
      // DKP 制:击杀记分(先出勤记分,再花分拿装);G团夜是打工,不记分
      members = gRunNight ? members : accrueDkpOnKill(members, teamIds, system);
      // 功绩统计(T12):出席者参与击杀一名首领(名人堂「功绩」陈列)
      members = members.map((member) =>
        teamIds.has(member.id) ? { ...member, bossKills: member.bossKills + 1 } : member,
      );

      // 胜利掉落 → G团夜整批卖给买家;公会团按现行分配制度归属
      // (逐件结算,后一件看到前一件的结果;tier 套装绑定:紫装落在套装部位即套装件)
      const [dropped, afterDrops] = rollDropItems(
        rngState,
        raid.dropQuality ?? RAID_DROP_QUALITY,
        boss.dropItemLevel,
        boss.dropsPerKill,
        RAID_SETTLEMENT.dropJitter,
        raid.set === undefined
          ? undefined
          : { id: raid.set.id, slots: raid.set.slots },
      );
      rngState = afterDrops;
      const outcomesOfDrop: DropOutcome[] = [];
      if (gRunNight) {
        // G团接单(T18,GLOSSARY:G团):成交价 = 金库抽成 + 出战团员均分打工费
        let pot = 0;
        for (const item of dropped) {
          pot += G_RUN.priceByQuality[item.quality];
          outcomesOfDrop.push({
            slot: item.slot,
            quality: item.quality,
            itemLevel: item.itemLevel,
            equipped: false,
            soldGold: G_RUN.priceByQuality[item.quality],
            ...(item.setId !== undefined ? { setId: item.setId } : {}),
          });
        }
        const vaultCut = Math.floor((pot * G_RUN.vaultCutPercent) / 100);
        const share = Math.floor((pot - vaultCut) / team.teamSize);
        const leftover = pot - vaultCut - share * team.teamSize;
        const vaultGain = vaultCut + leftover;
        currentVault = {
          gold: currentVault.gold + vaultGain,
          repairSpent: currentVault.repairSpent,
          incomeTotal: currentVault.incomeTotal + vaultGain,
        };
        members = members.map((member) =>
          teamIds.has(member.id) ? { ...member, personalGold: member.personalGold + share } : member,
        );
        gRunDropsSold += dropped.length;
        gRunVaultGoldIn += vaultGain;
        gRunGoldPerRaider += share;
        emit(
          `G团成交:本首领掉落 ${dropped.length} 件合计 ${pot} 金 —— 金库 +${vaultGain}(抽成),打工者每人 +${share} 金。`,
        );
      } else {
        for (const item of dropped) {
          const lineup = teamOrderIds
            .map((id) => members.find((member) => member.id === id))
            .filter((member): member is Member => member !== undefined);
          const allocation = distributeRaidDrop({
            members,
            team: lineup,
            item,
            system,
            selfDealing: params.economy.selfDealing,
            vault: currentVault,
            salvageGoldPerDrop: params.goal?.salvageGoldPerDrop,
            lootTilt: params.goal?.lootTilt,
          });
          members = allocation.members;
          currentVault = allocation.vault;
          nightSelfDealt += allocation.selfDealt ? 1 : 0;
          reputationCostTotal += allocation.reputationCost;
          personalGoldOut += allocation.outcome.goldPaid ?? 0;
          outcomesOfDrop.push({
            slot: item.slot,
            quality: item.quality,
            itemLevel: item.itemLevel,
            system: system.id,
            ...(item.setId !== undefined ? { setId: item.setId } : {}),
            ...allocation.outcome,
          });
          if (allocation.line !== undefined) {
            emit(allocation.line);
          }
        }
      }
      drops = outcomesOfDrop;
    } else {
      // 团灭:代价 = 修理金(金库余额封顶;抬价波期间按行情系数上浮)+ 疲劳 + 士气,无永久损失;本夜止步
      fallen = team.teamSize;
      const repairGold = Math.min(
        currentVault.gold,
        Math.round(RAID_SETTLEMENT.wipeRepairGoldPerRaider * team.teamSize * (params.repairCostFactor ?? 1)),
      );
      currentVault = {
        gold: currentVault.gold - repairGold,
        repairSpent: currentVault.repairSpent + repairGold,
        incomeTotal: currentVault.incomeTotal,
      };
      const wipeFatigue = RAID_SETTLEMENT.wipeFatigue;
      const moodHit = RAID_SETTLEMENT.wipeMoodHit;
      mapTeam((member) => ({
        ...member,
        fatigue: Math.min(LEVELING.maxFatigue, member.fatigue + wipeFatigue),
        mood: Math.max(0, member.mood - moodHit),
      }));
      const gateNote = !hardGateMet
        ? `,装等硬门槛 ${boss.hardGateItemLevel} 未达`
        : '';
      emit(
        `团灭于「${boss.name}」(胜率 ${chancePercent(successChance)}%${gateNote}),本夜止步第 ${ordinal} 首领。`,
      );
      emit(
        `团灭代价:修理金 ${repairGold} 金(金库余 ${currentVault.gold}),全员疲劳 +${RAID_SETTLEMENT.attemptFatiguePerBoss + wipeFatigue},士气 -${moodHit};无人退会,下周再战。`,
      );
      outcomes.push({
        bossId: boss.id,
        name: boss.name,
        killed: false,
        power: assessment.power,
        target: assessment.target,
        successChance,
        band: successChance <= 0 ? '必败' : successChance >= 1 ? '必胜' : '悬念',
        hardGateItemLevel: boss.hardGateItemLevel,
        hardGateMet,
        fallen,
        drops,
      });
      wiped = true;
      wipeIndex = ordinal;
      break;
    }

    outcomes.push({
      bossId: boss.id,
      name: boss.name,
      killed: true,
      power: assessment.power,
      target: assessment.target,
      successChance,
      band: successChance <= 0 ? '必败' : successChance >= 1 ? '必胜' : '悬念',
      hardGateItemLevel: boss.hardGateItemLevel,
      hardGateMet,
      fallen,
      drops,
    });
  }

  let repairGoldTotal = 0;
  if (wiped) {
    const boss = raid.bosses[wipeIndex - 1]!;
    repairGoldTotal = currentVault.repairSpent - vault.repairSpent;
    emit(
      `团本夜结束:「${raid.name}」${outcomes.length - 1}/${raid.bosses.length} 首领,止步于「${boss.name}」。`,
    );
  } else {
    // 全通:士气小涨(开荒成功,人心振奋)
    mapTeam((member) => ({
      ...member,
      mood: Math.min(100, member.mood + RAID_SETTLEMENT.clearMoodBoost),
    }));
    const dropCount = outcomes.reduce((sum, outcome) => sum + outcome.drops.length, 0);
    emit(
      `「${raid.name}」全通:${raid.bosses.length} 名首领尽诛,缴获 ${dropCount} 件装备,士气 +${RAID_SETTLEMENT.clearMoodBoost}。`,
    );
  }

  // 夜末制度心态(出席团员;会长角色的忠诚不随制度波动)+ 分配小结;
  // G团接单夜是打工性质:不走分配制度、不记制度心态,改记打工结算小结
  const vaultGoldIn = currentVault.incomeTotal - vault.incomeTotal;
  const signed = (value: number) => (value >= 0 ? `+${value}` : `${value}`);
  if (gRunNight) {
    emit(
      `本夜 G团结算:共卖出 ${gRunDropsSold} 件,金库入账 ${gRunVaultGoldIn} 金,每名打工者 +${gRunGoldPerRaider} 金(打工费入个人金)。`,
    );
  } else {
    members = applyLootSystemNightEffects(members, teamIds, system);
    const moodPart = system.attendeeMoodPerNight === 0 ? '心情不变' : `心情 ${signed(system.attendeeMoodPerNight)}`;
    const loyaltyPart =
      system.attendeeLoyaltyPerNight === 0
        ? '忠诚不变'
        : `出席者忠诚 ${signed(system.attendeeLoyaltyPerNight)}`;
    const goldPart = vaultGoldIn > 0 ? `金库入账 ${vaultGoldIn} 金、全团分红` : '金币未流动';
    emit(`本夜分配:「${system.name}」—— ${[loyaltyPart, moodPart, goldPart].join('、')}。`);
    if (nightSelfDealt > 0) {
      emit(`自肥 ${nightSelfDealt} 件:出席者忠诚逐件受损,声望 −${reputationCostTotal}(代价累积可见)。`);
    }
  }

  // 当周目标的心态钩子(T15,计划层):在制度心态之上叠加(钳制 0-100;
  // 忠诚与制度同款 —— 会长角色不随目标波动,且只波及出席者)
  const goal = params.goal;
  if (goal !== undefined && (goal.attendeeMoodPerNight !== 0 || goal.attendeeLoyaltyPerNight !== 0)) {
    members = members.map((member) => {
      if (!teamIds.has(member.id)) {
        return member;
      }
      return {
        ...member,
        loyalty: member.isChairman
          ? member.loyalty
          : Math.max(0, Math.min(100, member.loyalty + goal.attendeeLoyaltyPerNight)),
        mood: Math.max(0, Math.min(100, member.mood + goal.attendeeMoodPerNight)),
      };
    });
    const goalParts: string[] = [];
    if (goal.attendeeLoyaltyPerNight !== 0) {
      goalParts.push(`出席者忠诚 ${signed(goal.attendeeLoyaltyPerNight)}`);
    }
    if (goal.attendeeMoodPerNight !== 0) {
      goalParts.push(`心情 ${signed(goal.attendeeMoodPerNight)}`);
    }
    emit(`周目标「${goal.name}」:${goalParts.join('、')}。`);
  }

  const report: RaidNightReport = {
    raidId: raid.id,
    raidName: raid.name,
    atGameMinutes,
    size: raid.size,
    lineup: team.members.map((member, indexInTeam) => ({
      squadOrdinal: Math.floor(indexInTeam / 5) + 1,
      name: member.name,
      role: memberRole(member) ?? '?',
      itemLevel: averageItemLevel(member),
    })),
    teamItemLevel: team.averageItemLevel,
    bosses: outcomes,
    cleared: !wiped,
    wipe: wiped
      ? {
          bossIndex: wipeIndex,
          bossName: raid.bosses[wipeIndex - 1]!.name,
          repairGold: repairGoldTotal,
          fatigue: RAID_SETTLEMENT.wipeFatigue,
          moodHit: RAID_SETTLEMENT.wipeMoodHit,
        }
      : undefined,
    repairGold: repairGoldTotal,
    goal: goal !== undefined ? { id: goal.id, name: goal.name } : undefined,
    loot: gRunNight
      ? undefined
      : {
          system: system.id,
          vaultGoldIn,
          personalGoldOut,
          selfDealtCount: nightSelfDealt,
          attendeeLoyaltyPerNight: system.attendeeLoyaltyPerNight,
          attendeeMoodPerNight: system.attendeeMoodPerNight,
        },
    gRun: gRunNight
      ? {
          dropsSold: gRunDropsSold,
          vaultGoldIn: gRunVaultGoldIn,
          goldPerRaider: gRunGoldPerRaider,
        }
      : undefined,
    tactics: tactics.any
      ? {
          stance: { id: tactics.stanceId, name: tactics.stanceName },
          consumable: tactics.consumable,
          worldBuffs: tactics.worldBuffs.map((buff) => ({
            id: buff.id,
            name: buff.name,
            ready: buff.ready,
            bonusPercent: buff.bonusPercent,
            goldSpent: buff.goldSpent,
          })),
          bonusPowerPercent: tactics.bonusPowerPercent,
        }
      : undefined,
  };

  return {
    members,
    vault: currentVault,
    economy: {
      ...params.economy,
      selfDealtCount: params.economy.selfDealtCount + nightSelfDealt,
      selfDealReputationPaid: params.economy.selfDealReputationPaid + reputationCostTotal,
    },
    renownPoints: Math.max(0, params.renownPoints - reputationCostTotal),
    rngState,
    report,
  };
}
