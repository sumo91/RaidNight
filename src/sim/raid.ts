/**
 * 团本夜活动:第一档 40 人团本的整夜结算(T10)。
 *
 * 成败走统一结算引擎(sim/encounter.ts,与 5 人本同一套):
 * 团队战力 = (全团平均装等 + 职能分) × (1 + 各小队光环合计的平均%);
 * 首领可设「装等硬门槛」—— 全团平均装等不达标 ⇒ 必败,无论战力。
 * 一切可调数值在 content/raids.ts(数据驱动);纯函数、只走注入的种子随机链
 * (每首领一次成败掷点 → 胜利掉落抽取,顺序固定)。
 *
 * 演出级别(DESIGN「三级演出」):团本 = 直播视图 —— 结算产出结构化
 * RaidNightReport(首领血条、40 人点阵、滚动战斗日志的数据面)与逐条文本
 * (经门面入事件流);赛前决策(开团/编成)在赛前完成,赛中只观赛不可介入。
 * 团灭代价 = 修理金(公会金库,余额封顶)+ 疲劳 + 士气(心情),无永久损失:
 * 名册不动、忠诚不动、装备不丢,下个团本夜再战(开荒)。
 */

import { RAID_BY_ID, RAID_DROP_QUALITY, RAID_SETTLEMENT, RAIDS, type RaidDef } from '../content/raids';
import { LEVELING } from '../content/maps';
import type { Role } from '../content/classes';
import { composeSquad, memberRole, teamCheckOf } from './comp';
import { bestWearer, equipItem, rollDropItems } from './dungeon';
import { assessEncounter } from './encounter';
import { evaluateUnlockGates } from './ladder';
import { averageItemLevel, guildAverageItemLevel, guildAverageLevel } from './roster';
import { nextFloat } from './rng';
import type {
  DropOutcome,
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

/** 团队出战摘要:40 人(8 小队 × 5)的战力三要素聚合(统一结算引擎的输入)。 */
export interface RaidTeamSummary {
  /** 出战团员(按小队顺序、队内顺序解析成实体)。 */
  readonly members: readonly Member[];
  readonly teamSize: number;
  /** 全团平均装等(硬门槛与战力的装等刻度)。 */
  readonly averageItemLevel: number;
  /** 职能结构:全团坦克/治疗/输出计数(职能分由引擎按封顶计入)。 */
  readonly roleCounts: Readonly<Record<Role, number>>;
  /** 光环加成:各小队光环合计(伤害+生存+治疗)的平均百分比
   *  —— 小队光环只在队内生效(GLOSSARY),全团取平均即「光环覆盖度」。 */
  readonly auraBonusPercent: number;
}

/** 解析团队的出战阵容与战力三要素(团队检查通过时 = 8 支满员小队)。 */
export function raidTeam(
  members: readonly Member[],
  squads: readonly Squad[],
): RaidTeamSummary {
  const memberById = new Map(members.map((member) => [member.id, member]));
  const team: Member[] = [];
  const roleCounts: Record<Role, number> = { 坦克: 0, 治疗: 0, 输出: 0 };
  let auraTotal = 0;
  for (const [index, squad] of squads.entries()) {
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
      : team.reduce((sum, member) => sum + averageItemLevel(member), 0) / team.length;
  return {
    members: team,
    teamSize: team.length,
    averageItemLevel: teamItemLevel,
    roleCounts,
    auraBonusPercent: squads.length === 0 ? 0 : auraTotal / squads.length,
  };
}

/** 整夜结算入参。emit 把战斗日志文本交回门面(带时刻与序号入事件流)。 */
export interface SettleRaidNightParams {
  readonly members: readonly Member[];
  readonly squads: readonly Squad[];
  readonly vault: GuildVault;
  readonly plan: RaidPlan;
  readonly rngState: number;
  /** 团本夜时刻(= 游戏周边界;报告与日志的时刻)。 */
  readonly atGameMinutes: number;
  readonly emit: (text: string) => void;
}

export interface SettleRaidNightResult {
  readonly members: readonly Member[];
  readonly vault: GuildVault;
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
    return { members: params.members, vault, rngState: params.rngState };
  }

  // 开团复核①:内容阶梯门槛(开团后名册回落则取消 —— 未达标不可进入)
  const unlock = evaluateUnlockGates(raid.unlock, {
    averageLevel: guildAverageLevel(params.members),
    averageItemLevel: guildAverageItemLevel(params.members),
  });
  if (!unlock.unlocked) {
    emit(`团本夜取消:「${raid.name}」门槛未达(${unlock.unmet.join('、')}),本周不开团。`);
    return { members: params.members, vault, rngState: params.rngState };
  }

  // 开团复核②:团队检查(开团后淘汰/调离导致阵容不齐则取消,不算团灭)
  const check = teamCheckOf(params.members, squads);
  if (!check.passed) {
    emit(
      `团本夜取消:团队检查未通过(${check.failures.map((f) => f.text).join('、')}),补齐编成后下周再战。`,
    );
    return { members: params.members, vault, rngState: params.rngState };
  }

  let rngState = params.rngState;
  let members = params.members;
  let currentVault = vault;

  const team = raidTeam(members, squads);
  const teamIds = new Set(team.members.map((member) => member.id));
  const chancePercent = (value: number) => Math.round(value * 100);

  emit(
    `团本夜开始:「${raid.name}」—— ${raid.bosses.length} 名首领按顺序结算,全团 ${team.teamSize} 人,平均装等 ${Math.round(team.averageItemLevel)}。`,
  );

  /** 只更新出战团员(会长角色不在小队则不受团本夜影响)。 */
  const mapTeam = (update: (member: Member) => Member): void => {
    members = members.map((member) => (teamIds.has(member.id) ? update(member) : member));
  };

  const outcomes: RaidBossOutcome[] = [];
  let wiped = false;
  let wipeIndex = 0;

  for (const [index, boss] of raid.bosses.entries()) {
    const ordinal = index + 1;
    // 战力评估(不掷点)+ 硬门槛裁决:装等不达标 ⇒ 必败,无论战力
    const assessment = assessEncounter(
      {
        averageItemLevel: team.averageItemLevel,
        roleCounts: team.roleCounts,
        auraBonusPercent: team.auraBonusPercent,
      },
      boss.difficultyTarget,
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
      // 胜利掉落 → 全团择优穿戴(逐件结算,后一件看到前一件的换装结果)
      const [dropped, afterDrops] = rollDropItems(
        rngState,
        RAID_DROP_QUALITY,
        boss.dropItemLevel,
        boss.dropsPerKill,
        RAID_SETTLEMENT.dropJitter,
      );
      rngState = afterDrops;
      const outcomesOfDrop: DropOutcome[] = [];
      for (const item of dropped) {
        const candidates = members.filter((member) => teamIds.has(member.id));
        const best = bestWearer(candidates, item);
        if (best.delta > 0) {
          members = members.map((member) =>
            member.id === best.member.id ? equipItem(member, item) : member,
          );
          outcomesOfDrop.push({
            slot: item.slot,
            quality: item.quality,
            itemLevel: item.itemLevel,
            equipped: true,
            assignedTo: best.member.name,
            upgradeDelta: best.delta,
          });
          emit(
            `团本掉落:${item.quality}·${item.slot}(装等 ${item.itemLevel})→ ${best.member.name} 换上(+${best.delta})。`,
          );
        } else {
          outcomesOfDrop.push({
            slot: item.slot,
            quality: item.quality,
            itemLevel: item.itemLevel,
            equipped: false,
          });
          emit(`团本掉落:${item.quality}·${item.slot}(装等 ${item.itemLevel})无人可提升,随手分解。`);
        }
      }
      drops = outcomesOfDrop;
    } else {
      // 团灭:代价 = 修理金(金库余额封顶)+ 疲劳 + 士气,无永久损失;本夜止步
      fallen = team.teamSize;
      const repairGold = Math.min(
        currentVault.gold,
        RAID_SETTLEMENT.wipeRepairGoldPerRaider * team.teamSize,
      );
      currentVault = {
        gold: currentVault.gold - repairGold,
        repairSpent: currentVault.repairSpent + repairGold,
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

  const report: RaidNightReport = {
    raidId: raid.id,
    raidName: raid.name,
    atGameMinutes,
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
  };

  return { members, vault: currentVault, rngState, report };
}
