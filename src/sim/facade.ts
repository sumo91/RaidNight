import {
  BATTLEFIELD_BY_ID,
  HONOR_GEAR_BY_ID,
  PVP_SETTLEMENT,
} from '../content/pvp';
import { DAILY_FLAVOR_POOL } from '../content/daily-flavor';
import { COMP } from '../content/comp';
import { DUNGEON_BY_ID } from '../content/dungeons';
import { EXTERNAL_ACTIVITY_BY_ID, LOOT_SYSTEM_BY_ID, type ExternalActivityId } from '../content/economy';
import { LEVELING_MAP_BY_ID } from '../content/maps';
import { WEEKLY_GOAL_BY_ID } from '../content/plan';
import { RAID_BY_ID } from '../content/raids';
import {
  CONSUMABLE_TIER_BY_ID,
  RAID_STANCE_BY_ID,
  WORLD_BUFF_BY_ID,
} from '../content/raid-tactics';
import type { GuildCommand } from './commands';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK, gameDay, gameWeek } from './clock';
import { equipItem, settleDungeonDay, squadDungeon, squadDungeonReadiness } from './dungeon';
import { settleExternalDay, squadExternalActivity } from './economy';
import type { SimEvent, SimEventKind } from './events';
import { evaluateUnlockGates } from './ladder';
import { teamCheck, teamCheckOf } from './comp';
import { guildAverageItemLevel, guildAverageLevel } from './roster';
import { settleLevelingDay, squadLevelingMap } from './leveling';
import {
  accrueBenchDays,
  autoResignations,
  evaluateMilestones,
  firstKillPointsForRaidTier,
  firstKillsFromRaidNight,
  hallDeedsLine,
  hallEntryFor,
  rareDropsFromRaidNight,
  renownLabel,
  renownRung,
  renownStanding,
  rosterCapForRung,
} from './reputation';
import { settleRaidNight, tacticsInvestmentGold } from './raid';
import {
  battlefieldSquadCount,
  honorRankOf,
  honorRankRung,
  squadBattlefield,
  settleBattlefieldDay,
} from './pvp';
import { generateApplicantPool } from './recruit';
import { pickOne } from './rng';
import { repairCostFactor, settleWorldDay, settleWorldWeek } from './world';
import {
  createInitialState,
  normalizeGuildName,
  type GameState,
  type GuildEconomy,
  type Member,
  type RaidNightReport,
  type RaidPlan,
  type RareDropRecord,
  type Squad,
  type WeeklyPlan,
} from './state';

// 存档 API 经门面接缝对外暴露(ADR-0003:版本化 + 迁移;纯函数见 sim/save.ts)
export {
  decodeSave,
  decodeSaveEnvelope,
  encodeSave,
  SAVE_KIND,
  SAVE_VERSION,
  type DecodedSave,
  type SaveFile,
} from './save';

/**
 * 模拟门面 —— 全项目唯一测试接缝。
 *
 * 输入 = 会长指令(可选)+ 游戏时间增量;输出 = 新状态 + 事件日志。
 * 确定性:固定种子下,相同的指令与时间增量序列产生相同的状态与日志
 * (随机只走注入的种子随机源,现实时间不进入门面)。
 */

/** 门面输入:一步 = 最多一条会长指令 + 一段游戏时间增量(游戏分钟)。 */
export interface SimInput {
  readonly command?: GuildCommand;
  readonly deltaGameMinutes: number;
}

/** 门面输出:新状态 + 本步新增的事件(按发生顺序)。 */
export interface StepOutput {
  readonly state: GameState;
  readonly events: readonly SimEvent[];
}

/** 事件收集器:负责全局序号递增。 */
class EventCollector {
  private seq: number;
  readonly events: SimEvent[] = [];

  constructor(startSeq: number) {
    this.seq = startSeq;
  }

  push(atGameMinutes: number, kind: SimEventKind, text: string): void {
    this.events.push({ seq: this.seq++, atGameMinutes, kind, text });
  }

  get nextSeq(): number {
    return this.seq;
  }
}

/** 纯步进:同状态 + 同输入 ⇒ 同输出;不得原地修改 prev。 */
export function step(prev: GameState, input: SimInput): StepOutput {
  const collector = new EventCollector(prev.nextEventSeq);
  let state = prev;

  // 1) 会长指令在本步起始时刻生效
  if (input.command !== undefined) {
    state = applyCommand(state, input.command, collector);
  }

  // 2) 推进游戏时间:按日/周边界结算(自动层在 T1 的最小粒度:游戏日)
  state = advanceClock(state, quantizeDelta(input.deltaGameMinutes), collector);

  return { state: { ...state, nextEventSeq: collector.nextSeq }, events: collector.events };
}

/** 时间增量取整与非负化:浮点/负数输入不破坏确定性。 */
function quantizeDelta(raw: number): number {
  return Math.max(0, Math.floor(raw));
}

function applyCommand(state: GameState, command: GuildCommand, collector: EventCollector): GameState {
  switch (command.type) {
    case 'renameGuild': {
      const name = normalizeGuildName(command.name);
      if (name === undefined || name === state.guild.name) {
        return state; // 非法或无变化:状态不变、无事件
      }
      collector.push(state.clockGameMinutes, '公会', `公会更名为「${name}」。`);
      return { ...state, guild: { name } };
    }
    case 'recruitApplicant': {
      const applicant = state.applicants.find((a) => a.applicationId === command.applicationId);
      if (applicant === undefined) {
        return state; // 申请不存在(已被处理或已过期):忽略
      }
      if (state.members.length >= state.rosterCap) {
        return state; // 名册已满:不可再招(验收标准 3)
      }
      const member: Member = {
        id: state.nextMemberId,
        isChairman: false,
        joinedAtGameMinutes: state.clockGameMinutes,
        benchDays: 0,
        ...applicant.profile,
      };
      collector.push(state.clockGameMinutes, '招募', `「${member.name}」通过申请,正式入册。`);
      return {
        ...state,
        members: [...state.members, member],
        applicants: state.applicants.filter((a) => a.applicationId !== command.applicationId),
        nextMemberId: state.nextMemberId + 1,
      };
    }
    case 'rejectApplicant': {
      const applicant = state.applicants.find((a) => a.applicationId === command.applicationId);
      if (applicant === undefined) {
        return state; // 申请不存在:忽略
      }
      collector.push(state.clockGameMinutes, '招募', `婉拒了「${applicant.profile.name}」的申请。`);
      return {
        ...state,
        applicants: state.applicants.filter((a) => a.applicationId !== command.applicationId),
      };
    }
    case 'dismissMember': {
      const member = state.members.find((m) => m.id === command.memberId);
      if (member === undefined || member.isChairman) {
        return state; // 团员不存在或为会长角色:忽略(会长不能淘汰自己)
      }
      collector.push(state.clockGameMinutes, '招募', `「${member.name}」被淘汰出会。`);
      // 离会即入名人堂(GLOSSARY:含已离会者的去向与功绩;台词/去向按团员 id 确定)
      const entry = hallEntryFor(member, '会长淘汰', state.clockGameMinutes);
      return {
        ...state,
        members: state.members.filter((m) => m.id !== command.memberId),
        // 淘汰同时清编:人走队清,小队不悬挂已离会团员
        squads: removeFromSquads(state.squads, command.memberId),
        hallOfFame: [...state.hallOfFame, entry],
      };
    }
    case 'createSquad': {
      if (state.squads.length >= COMP.maxSquads) {
        return state; // 小队数已达上限(团队 = 8 小队):忽略
      }
      const ordinal = state.squads.length + 1;
      collector.push(state.clockGameMinutes, '编成', `第 ${ordinal} 小队成立。`);
      return {
        ...state,
        squads: [...state.squads, { id: state.nextSquadId, memberIds: [] }],
        nextSquadId: state.nextSquadId + 1,
      };
    }
    case 'disbandSquad': {
      const index = state.squads.findIndex((squad) => squad.id === command.squadId);
      if (index === -1 || state.squads[index]!.memberIds.length > 0) {
        return state; // 小队不存在或仍有队员:忽略(只解散空小队)
      }
      collector.push(state.clockGameMinutes, '编成', `第 ${index + 1} 小队解散。`);
      return { ...state, squads: state.squads.filter((squad) => squad.id !== command.squadId) };
    }
    case 'assignToSquad': {
      const member = state.members.find((m) => m.id === command.memberId);
      const index = state.squads.findIndex((squad) => squad.id === command.squadId);
      if (member === undefined || index === -1) {
        return state; // 团员或小队不存在:忽略
      }
      if (state.squads[index]!.memberIds.includes(member.id)) {
        return state; // 已在该小队:无变化、无事件
      }
      // 一名团员同一时刻只在一支小队:先从原队调离再编入
      const vacancies = removeFromSquads(state.squads, member.id);
      if (vacancies[index]!.memberIds.length >= COMP.squadSize) {
        return state; // 目标小队已满(5 人制):拒绝
      }
      const squads = vacancies.map((squad, i) =>
        i === index ? { ...squad, memberIds: [...squad.memberIds, member.id] } : squad,
      );
      collector.push(state.clockGameMinutes, '编成', `「${member.name}」编入第 ${index + 1} 小队。`);
      return { ...state, squads };
    }
    case 'removeFromSquad': {
      const member = state.members.find((m) => m.id === command.memberId);
      const index = state.squads.findIndex((squad) => squad.memberIds.includes(command.memberId));
      if (member === undefined || index === -1) {
        return state; // 团员不在任何小队(或已离会):忽略
      }
      collector.push(state.clockGameMinutes, '编成', `「${member.name}」调离第 ${index + 1} 小队。`);
      return { ...state, squads: removeFromSquads(state.squads, member.id) };
    }
    case 'assignLevelingMap': {
      const index = state.squads.findIndex((squad) => squad.id === command.squadId);
      if (index === -1) {
        return state; // 小队不存在:忽略
      }
      const map = LEVELING_MAP_BY_ID.get(command.mapId);
      if (map === undefined) {
        return state; // 地图不在内容表:忽略
      }
      // 解锁校验只发生在安排时刻:公会平均等级达到等级带下限才可进驻
      // (安排之后平均等级回落不打断进行中的练级)
      if (guildAverageLevel(state.members) < map.levelBand.min) {
        return state; // 未解锁:忽略
      }
      const current = squadLevelingMap(state.squads[index]!);
      if (current?.id === map.id) {
        return state; // 已在该地图:无变化、无事件
      }
      collector.push(
        state.clockGameMinutes,
        '练级',
        `第 ${index + 1} 小队进驻「${map.name}」(${map.tier}区)练级。`,
      );
      const squads = state.squads.map((squad, i) =>
        i === index ? { ...squad, activity: { type: 'leveling' as const, mapId: map.id } } : squad,
      );
      return { ...state, squads };
    }
    case 'stopLeveling': {
      const index = state.squads.findIndex((squad) => squad.id === command.squadId);
      if (index === -1) {
        return state; // 小队不存在:忽略
      }
      if (squadLevelingMap(state.squads[index]!) === undefined) {
        return state; // 本就没有练级安排(或地图已失效):忽略
      }
      collector.push(state.clockGameMinutes, '练级', `第 ${index + 1} 小队结束练级,回城休整。`);
      const squads = state.squads.map((squad, i) =>
        i === index ? { ...squad, activity: undefined } : squad,
      );
      return { ...state, squads };
    }
    case 'assignDungeon': {
      const index = state.squads.findIndex((squad) => squad.id === command.squadId);
      if (index === -1) {
        return state; // 小队不存在:忽略
      }
      const dungeon = DUNGEON_BY_ID.get(command.dungeonId);
      if (dungeon === undefined) {
        return state; // 副本不在内容表:忽略
      }
      // 解锁校验只发生在安排时刻(与练级地图同一规则):门槛双维
      // (公会平均等级 + 公会平均装等)任一未达标即拒绝,判定在 sim/ladder.ts
      const unlock = evaluateUnlockGates(dungeon.unlock, {
        averageLevel: guildAverageLevel(state.members),
        averageItemLevel: guildAverageItemLevel(state.members),
      });
      if (!unlock.unlocked) {
        return state; // 未达标:忽略
      }
      // 进本门槛:满职能小队(满员 5 人 + 至少 1 坦 1 奶)才可进驻
      const readiness = squadDungeonReadiness(state.squads[index]!, state.members);
      if (!readiness.ready) {
        return state; // 编成不齐:忽略(编成页会标示缺口)
      }
      if (squadDungeon(state.squads[index]!)?.id === dungeon.id) {
        return state; // 已在该副本:无变化、无事件
      }
      collector.push(
        state.clockGameMinutes,
        '下本',
        `第 ${index + 1} 小队进驻「${dungeon.name}」(${dungeon.tier}档),每日自动下本 ${dungeon.runsPerDay} 次。`,
      );
      const squads = state.squads.map((squad, i) =>
        i === index ? { ...squad, activity: { type: 'dungeon' as const, dungeonId: dungeon.id } } : squad,
      );
      return { ...state, squads };
    }
    case 'stopDungeon': {
      const index = state.squads.findIndex((squad) => squad.id === command.squadId);
      if (index === -1) {
        return state; // 小队不存在:忽略
      }
      if (squadDungeon(state.squads[index]!) === undefined) {
        return state; // 本就没有下本安排(或副本已失效):忽略
      }
      collector.push(state.clockGameMinutes, '下本', `第 ${index + 1} 小队结束下本,回城休整。`);
      const squads = state.squads.map((squad, i) =>
        i === index ? { ...squad, activity: undefined } : squad,
      );
      return { ...state, squads };
    }
    case 'openRaid': {
      const raid = RAID_BY_ID.get(command.raidId);
      if (raid === undefined) {
        return state; // 团本不在内容表:忽略
      }
      // 内容阶梯门槛:与 5 人本同一双维判定(未达标不可见/不可进入)
      const unlock = evaluateUnlockGates(raid.unlock, {
        averageLevel: guildAverageLevel(state.members),
        averageItemLevel: guildAverageItemLevel(state.members),
      });
      if (!unlock.unlocked) {
        return state; // 未解锁:忽略
      }
      // 团队检查:通过后方可开团(验收标准 1)
      if (!teamCheck(state).passed) {
        return state; // 阵容不齐:忽略(编成页会标示缺口)
      }
      if (state.raidPlan?.raidId === raid.id) {
        return state; // 已开同一团本:无变化、无事件
      }
      collector.push(
        state.clockGameMinutes,
        '团本',
        `已开团:「${raid.name}」—— 团本夜定于周边界打响,按首领顺序逐个结算。`,
      );
      return {
        ...state,
        raidPlan: { raidId: raid.id, openedAtGameMinutes: state.clockGameMinutes },
      };
    }
    case 'cancelRaid': {
      if (state.raidPlan === undefined) {
        return state; // 本就没有开团安排:忽略
      }
      // 决策金在指令时刻已扣:取消安排 ⇒ 本周采购作废(开荒决策面的时效成本)
      const wasted = tacticsInvestmentGold(state.raidPlan);
      collector.push(state.clockGameMinutes, '团本', '取消开团安排,本周不开团。');
      if (wasted > 0) {
        collector.push(
          state.clockGameMinutes,
          '团本',
          `本周赛前采购 ${wasted} 金(消耗品与世界 Buff)随之作废 —— 下周重新开团、重新决策。`,
        );
      }
      return { ...state, raidPlan: undefined };
    }
    case 'setWeeklyPlan': {
      const goal = WEEKLY_GOAL_BY_ID.get(command.goal);
      const raid = RAID_BY_ID.get(command.raidId);
      if (goal === undefined || raid === undefined) {
        return state; // 未知目标或团本不在内容表:忽略
      }
      if (state.weeklyPlan?.goal === goal.id && state.weeklyPlan.raidId === raid.id) {
        return state; // 计划无变化:无事件
      }
      const weeklyPlan: WeeklyPlan = {
        goal: goal.id,
        raidId: raid.id,
        setAtGameMinutes: state.clockGameMinutes,
      };
      collector.push(
        state.clockGameMinutes,
        '团本',
        `周计划设定:每周开「${raid.name}」,当周目标「${goal.name}」(${goal.tagline})—— 自动层照计划排班,无需逐场手动。`,
      );
      let raidPlan = state.raidPlan;
      if (raidPlan === undefined) {
        // 本周尚未开团:自动层立即照新计划把本周排上
        //(本周已手动开团的不被计划覆盖 —— 手动安排优先,夜结束照常清空)
        raidPlan = autoOpenPerWeeklyPlan(
          weeklyPlan,
          state.members,
          state.squads,
          state.clockGameMinutes,
          collector,
        );
      }
      return { ...state, raidPlan, weeklyPlan };
    }
    case 'clearWeeklyPlan': {
      if (state.weeklyPlan === undefined) {
        return state; // 本就没有周计划:忽略
      }
      collector.push(
        state.clockGameMinutes,
        '团本',
        '周计划已取消 —— 此后团本夜需手动开团;本周已开的团不受影响。',
      );
      return { ...state, weeklyPlan: undefined };
    }
    case 'setConsumableBudget': {
      const plan = state.raidPlan;
      if (plan === undefined) {
        return state; // 未开团:没有可为之采购的团本夜,忽略
      }
      const def = CONSUMABLE_TIER_BY_ID.get(command.tier);
      if (def === undefined) {
        return state; // 档位不在内容表:忽略
      }
      if (plan.tactics?.consumableTier === def.id) {
        return state; // 已是该档:无变化、无事件(不重复拨款)
      }
      if (state.vault.gold < def.costGold) {
        return state; // 金库拨款不足:买不成(金库页会标示余额)
      }
      const vault = { ...state.vault, gold: state.vault.gold - def.costGold };
      const rebudget = plan.tactics?.consumableTier !== undefined;
      collector.push(
        state.clockGameMinutes,
        '团本',
        `开荒采购:金库拨款 ${def.costGold} 金购入「${def.name}」,当夜全团战力 +${def.powerBonusPercent}%${rebudget ? ';此前拨款作废' : ''}。`,
      );
      return {
        ...state,
        vault,
        raidPlan: {
          ...plan,
          tactics: { ...plan.tactics, consumableTier: def.id },
        },
      };
    }
    case 'armWorldBuff': {
      const plan = state.raidPlan;
      if (plan === undefined) {
        return state; // 未开团:没有可为之筹备的团本夜,忽略
      }
      const def = WORLD_BUFF_BY_ID.get(command.buffId);
      if (def === undefined) {
        return state; // Buff 不在内容表:忽略
      }
      const armed = plan.tactics?.worldBuffs ?? [];
      if (armed.some((entry) => entry.buffId === def.id)) {
        return state; // 已在筹备:无变化、无事件(不重复拨款)
      }
      if (state.vault.gold < def.costGold) {
        return state; // 金库拨款不足:启程不成
      }
      const vault = { ...state.vault, gold: state.vault.gold - def.costGold };
      collector.push(
        state.clockGameMinutes,
        '团本',
        `世界Buff 启用:「${def.name}」—— 金库拨款 ${def.costGold} 金启程筹备,需 ${def.prepGameDays} 个游戏日;团本夜前备妥则当夜战力 +${def.powerBonusPercent}%。`,
      );
      return {
        ...state,
        vault,
        raidPlan: {
          ...plan,
          tactics: {
            ...plan.tactics,
            worldBuffs: [
              ...armed,
              { buffId: def.id, armedAtGameMinutes: state.clockGameMinutes },
            ],
          },
        },
      };
    }
    case 'setRaidStance': {
      const plan = state.raidPlan;
      if (plan === undefined) {
        return state; // 未开团:没有可为之微调的团队,忽略
      }
      const def = RAID_STANCE_BY_ID.get(command.stance);
      if (def === undefined || plan.tactics?.stance === def.id) {
        return state; // 阵形不在内容表或本就是现行阵形:忽略
      }
      collector.push(
        state.clockGameMinutes,
        '团本',
        `编成微调:团本夜改用「${def.name}」—— ${def.tagline}`,
      );
      return {
        ...state,
        raidPlan: { ...plan, tactics: { ...plan.tactics, stance: def.id } },
      };
    }
    case 'assignCarry':
    case 'assignWildRaid':
      return assignExternal(
        state,
        command.type === 'assignCarry' ? 'carry' : 'wildRaid',
        command.squadId,
        collector,
      );
    case 'stopCarry':
    case 'stopWildRaid': {
      const wanted: ExternalActivityId = command.type === 'stopCarry' ? 'carry' : 'wildRaid';
      const index = state.squads.findIndex((squad) => squad.id === command.squadId);
      const current = index === -1 ? undefined : squadExternalActivity(state.squads[index]!);
      if (current === undefined || current.id !== wanted) {
        return state; // 小队不存在或本就没有这项外快:忽略
      }
      collector.push(
        state.clockGameMinutes,
        '经济',
        `第 ${index + 1} 小队结束${current.name},回城休整。`,
      );
      const squads = state.squads.map((squad, i) =>
        i === index ? { ...squad, activity: undefined } : squad,
      );
      return { ...state, squads };
    }
    case 'assignBattlefield': {
      const index = state.squads.findIndex((squad) => squad.id === command.squadId);
      if (index === -1) {
        return state; // 小队不存在:忽略
      }
      const def = BATTLEFIELD_BY_ID.get(command.battlefieldId);
      if (def === undefined) {
        return state; // 战场不在内容表:忽略
      }
      // 内容阶梯门槛(与 5 人本同一双维判定):梯度未解锁不可进入
      const unlock = evaluateUnlockGates(def.unlock, {
        averageLevel: guildAverageLevel(state.members),
        averageItemLevel: guildAverageItemLevel(state.members),
      });
      if (!unlock.unlocked) {
        return state; // 未达标:忽略
      }
      // 战场队门槛:满职能小队(与下本/外快同一门槛)才可编入
      const readiness = squadDungeonReadiness(state.squads[index]!, state.members);
      if (!readiness.ready) {
        return state; // 编成不齐:忽略(编成页会标示缺口)
      }
      if (squadBattlefield(state.squads[index]!)?.id === def.id) {
        return state; // 已在该战场:无变化、无事件
      }
      // 战场队 = 2–3 小队(DESIGN「编成」):已满 3 支不可再编
      const teamSize = battlefieldSquadCount(state.squads, def.id);
      if (teamSize >= PVP_SETTLEMENT.maxSquadsPerBattlefield) {
        return state; // 战场队已满:忽略
      }
      collector.push(
        state.clockGameMinutes,
        '战场',
        `第 ${index + 1} 小队编入战场队,进驻「${def.name}」(第 ${def.gradient} 梯度,${teamSize + 1}/${PVP_SETTLEMENT.maxSquadsPerBattlefield} 支小队)—— 每日自动开打 ${def.battlesPerDay} 场,胜负皆得荣誉。`,
      );
      const squads = state.squads.map((squad, i) =>
        i === index
          ? { ...squad, activity: { type: 'battlefield' as const, battlefieldId: def.id } }
          : squad,
      );
      return { ...state, squads };
    }
    case 'stopBattlefield': {
      const index = state.squads.findIndex((squad) => squad.id === command.squadId);
      if (index === -1 || squadBattlefield(state.squads[index]!) === undefined) {
        return state; // 小队不存在或本就没有战场安排:忽略
      }
      collector.push(state.clockGameMinutes, '战场', `第 ${index + 1} 小队撤出战场,回城休整。`);
      const squads = state.squads.map((squad, i) =>
        i === index ? { ...squad, activity: undefined } : squad,
      );
      return { ...state, squads };
    }
    case 'redeemHonorGear': {
      const member = state.members.find((m) => m.id === command.memberId);
      const gear = HONOR_GEAR_BY_ID.get(command.gearId);
      if (member === undefined || gear === undefined) {
        return state; // 团员不存在或军装不在内容表:忽略
      }
      // 军衔门槛(GLOSSARY:荣誉阶梯):生涯荣誉未到军衔阶,兑不了
      const rankOrder = honorRankRung(state.honor.career) + 1;
      if (rankOrder < gear.requiredRankOrder) {
        return state; // 军衔不足:忽略
      }
      if (state.honor.points < gear.costHonor) {
        return state; // 荣誉点不足:忽略
      }
      // 兑换即穿上:换装走全项目唯一入口(战场向属性随之入格)
      const members = state.members.map((m) =>
        m.id === member.id
          ? equipItem(m, {
              slot: gear.slot,
              quality: gear.quality,
              itemLevel: gear.itemLevel,
              pvpPower: gear.pvpPower,
            })
          : m,
      );
      collector.push(
        state.clockGameMinutes,
        '战场',
        `军装兑换:「${member.name}」花 ${gear.costHonor} 荣誉点穿上「${gear.name}」(装等 ${gear.itemLevel},战场向属性 +${gear.pvpPower};荣誉点余 ${state.honor.points - gear.costHonor})。`,
      );
      return {
        ...state,
        members,
        honor: { ...state.honor, points: state.honor.points - gear.costHonor },
      };
    }
    case 'setLootSystem': {
      const def = LOOT_SYSTEM_BY_ID.get(command.system);
      if (def === undefined || def.id === state.economy.system) {
        return state; // 未知制度或本就是现行制度:忽略
      }
      if (state.vault.gold < def.switchCostGold) {
        return state; // 立规费付不起:换不成(转换成本是真实的,验收标准 3)
      }
      const vault = { ...state.vault, gold: state.vault.gold - def.switchCostGold };
      // 换制摩擦:全员(会长角色除外)忠诚一次性下降(0-100 钳制)
      const members = state.members.map((member) =>
        member.isChairman
          ? member
          : { ...member, loyalty: Math.max(0, member.loyalty - def.switchLoyaltyHit) },
      );
      // 换入 DKP:积分清零重记(旧分随旧制度作废 —— 换制的真实代价之一)
      const settled = def.id === 'dkp' ? members.map((member) => ({ ...member, dkp: 0 })) : members;
      // 自肥只存在于会长裁量制:换出即自动收手
      const economy: GuildEconomy = {
        ...state.economy,
        system: def.id,
        systemSinceGameMinutes: state.clockGameMinutes,
        selfDealing: def.id === 'chairman' ? state.economy.selfDealing : false,
      };
      const costParts = [
        `立规支出 ${def.switchCostGold} 金(金库余 ${vault.gold})`,
        `全员忠诚 −${def.switchLoyaltyHit}`,
      ];
      if (def.id === 'dkp') {
        costParts.push('DKP 清零重记');
      }
      collector.push(
        state.clockGameMinutes,
        '经济',
        `分配制度改为「${def.name}」:${costParts.join(',')}。`,
      );
      return { ...state, vault, members: settled, economy };
    }
    case 'setSelfDealing': {
      if (state.economy.system !== 'chairman' || state.economy.selfDealing === command.enabled) {
        return state; // 自肥只在会长裁量制下存在;开关无变化:忽略
      }
      const def = LOOT_SYSTEM_BY_ID.get('chairman')!;
      const economy: GuildEconomy = { ...state.economy, selfDealing: command.enabled };
      collector.push(
        state.clockGameMinutes,
        '经济',
        command.enabled
          ? `会长宣布实行自肥:团本掉落优先装进会长角色 —— 每件自肥,出席者忠诚 −${def.selfDealLoyaltyCost}、声望 −${def.selfDealReputationCost},代价逐件累积。`
          : '会长收手了:自肥结束,掉落回到正常裁量。',
      );
      return { ...state, economy };
    }
  }
}

/**
 * 安排外快(G团打工/野团,GLOSSARY:打工/野团):
 * 小队存在 + 内容解锁 + 满职能(与下本同一门槛)才成立;已在同一外快则无变化。
 * 收入归个人金(GLOSSARY:个人金),结算在 sim/economy.ts 的逐日外快结算。
 */
function assignExternal(
  state: GameState,
  activityId: ExternalActivityId,
  squadId: number,
  collector: EventCollector,
): GameState {
  const index = state.squads.findIndex((squad) => squad.id === squadId);
  if (index === -1) {
    return state; // 小队不存在:忽略
  }
  const def = EXTERNAL_ACTIVITY_BY_ID.get(activityId);
  if (def === undefined) {
    return state; // 活动不在内容表:忽略
  }
  const unlock = evaluateUnlockGates(def.unlock, {
    averageLevel: guildAverageLevel(state.members),
    averageItemLevel: guildAverageItemLevel(state.members),
  });
  if (!unlock.unlocked) {
    return state; // 未解锁:忽略
  }
  const readiness = squadDungeonReadiness(state.squads[index]!, state.members);
  if (!readiness.ready) {
    return state; // 编成不齐:忽略(编成页会标示缺口)
  }
  if (squadExternalActivity(state.squads[index]!)?.id === def.id) {
    return state; // 已在该外快:无变化、无事件
  }
  collector.push(
    state.clockGameMinutes,
    '经济',
    `第 ${index + 1} 小队出坞${def.name}:每人每日 +${def.goldPerMemberPerDay} 金入个人金,疲劳 +${def.fatiguePerMemberPerDay}。`,
  );
  const squads = state.squads.map((squad, i) =>
    i === index ? { ...squad, activity: { type: activityId } } : squad,
  );
  return { ...state, squads };
}

/**
 * 自动层照周计划开团(计划层执行,T15):与手动 openRaid 同一门槛 ——
 * 内容阶梯 + 团队检查,通过即开出当周安排;暂缓/失效只记一条事件
 * (会长可见,条件满足后照计划自动恢复)。纯裁决:不改状态、不掷随机。
 */
function autoOpenPerWeeklyPlan(
  plan: WeeklyPlan,
  members: readonly Member[],
  squads: readonly Squad[],
  atGameMinutes: number,
  collector: EventCollector,
): RaidPlan | undefined {
  const raid = RAID_BY_ID.get(plan.raidId);
  if (raid === undefined) {
    collector.push(
      atGameMinutes,
      '团本',
      '自动层停开:周计划所指的团本已不在团本表中 —— 请调整计划。',
    );
    return undefined;
  }
  const unlock = evaluateUnlockGates(raid.unlock, {
    averageLevel: guildAverageLevel(members),
    averageItemLevel: guildAverageItemLevel(members),
  });
  if (!unlock.unlocked) {
    collector.push(
      atGameMinutes,
      '团本',
      `自动层暂缓开团:「${raid.name}」门槛未达(${unlock.unmet.join('、')})—— 条件满足后照计划执行。`,
    );
    return undefined;
  }
  const check = teamCheckOf(members, squads);
  if (!check.passed) {
    collector.push(
      atGameMinutes,
      '团本',
      `自动层暂缓开团:团队检查未通过(${check.failures.map((f) => f.text).join('、')})—— 补齐编成后照计划执行。`,
    );
    return undefined;
  }
  collector.push(
    atGameMinutes,
    '团本',
    `自动层按周计划开团:「${raid.name}」—— 团本夜定于周边界打响,按首领顺序逐个结算。`,
  );
  return { raidId: raid.id, openedAtGameMinutes: atGameMinutes };
}

/** 从所有小队移除一名团员(保持小队顺序与队内顺序;返回新数组)。 */
function removeFromSquads(squads: readonly Squad[], memberId: number): readonly Squad[] {
  return squads.map((squad) =>
    squad.memberIds.includes(memberId)
      ? { ...squad, memberIds: squad.memberIds.filter((id) => id !== memberId) }
      : squad,
  );
}

function advanceClock(state: GameState, delta: number, collector: EventCollector): GameState {
  if (delta <= 0) {
    return state;
  }
  const target = state.clockGameMinutes + delta;
  let cursor = state.clockGameMinutes;
  let rngState = state.rngState;
  let members = state.members;
  let squads = state.squads;
  let applicants = state.applicants;
  let nextApplicationId = state.nextApplicationId;
  let lastDungeonRun = state.lastDungeonRun;
  let honor = state.honor;
  let lastBattlefieldReport = state.lastBattlefieldReport;
  let vault = state.vault;
  let economy = state.economy;
  let renownPoints = state.renownPoints;
  let raidPlan = state.raidPlan;
  let lastRaidNight = state.lastRaidNight;
  let honorWall = state.honorWall;
  let hallOfFame = state.hallOfFame;
  let rosterCap = state.rosterCap;
  let world = state.world;
  // 周计划(计划层,T15):循环内不改模板,自动层只照它每周开团
  const weeklyPlan = state.weeklyPlan;

  // 逐个跨越的边界结算;游戏周边界必是游戏日边界(分钟数整除)。
  // 日界结算顺序固定:日更文案 → 申请池刷新(→ 虚拟服务器日结算:行情波/抢苗子)
  // → 练级/休整 → 下本结算 → 外快结算 → 战场结算(T16,自动层)
  // →(周界)团本夜整夜结算 → 周更(团本 CD 重置)
  // → 声望与荣誉(T12,确定性不消费随机链):冷板凳计数 → 稀有入墙 → 首杀
  //   → 里程碑 → 军衔晋升(T16)→ 阶位/名册上限 → 自动退会
  // →(周界)虚拟服务器周结算(T13,不消费随机链):玩家服务器首杀 → 橡皮筋
  //   (竞争公会推进/超车)→ 排名名次段新闻。
  for (;;) {
    const nextDayAt = (Math.floor(cursor / GAME_MINUTES_PER_DAY) + 1) * GAME_MINUTES_PER_DAY;
    const nextWeekAt = (Math.floor(cursor / GAME_MINUTES_PER_WEEK) + 1) * GAME_MINUTES_PER_WEEK;
    const nextAt = Math.min(nextDayAt, nextWeekAt);
    if (nextAt > target) {
      break;
    }
    cursor = nextAt;
    let tonightReport: RaidNightReport | undefined;

    const [flavor, afterFlavor] = pickOne(rngState, DAILY_FLAVOR_POOL);
    rngState = afterFlavor;
    collector.push(nextAt, '日更', `第 ${gameDay(nextAt)} 天:${flavor}`);

    // 申请池每日刷新:未处理的申请全部作废,按当日声望阶位规格重生成
    // (GLOSSARY:申请池依据声望每日刷新;阶位 = 档序 × 3 + 星,T12 真值)
    const pool = generateApplicantPool(rngState, renownRung(renownPoints), members, nextApplicationId);
    rngState = pool.rngState;
    applicants = pool.applicants;
    nextApplicationId = pool.nextApplicationId;
    collector.push(nextAt, '招募', `申请池刷新:${applicants.length} 名冒险者递来了申请。`);

    // 虚拟服务器日结算(T13,GLOSSARY:虚拟服务器;纯确定性不消费随机链):
    // 行情波(抬价,轻量可感知)与抢苗子(竞争公会截走最好的一份申请,绝不截空);
    // 全服新闻入事件流
    const worldDay = settleWorldDay({ world, applicants, atGameMinutes: nextAt });
    world = worldDay.world;
    applicants = worldDay.applicants;
    for (const text of worldDay.news) {
      collector.push(nextAt, '世界', text);
    }

    // 练级结算(自动层,静默计数):进驻地图的队员成长与积劳,其余无安排者休整
    const day = settleLevelingDay(members, squads, rngState);
    members = day.members;
    rngState = day.rngState;

    // 下本结算(自动层,结果卡 + 短日志):进驻 5 人本的小队逐次结算、掉落择优穿戴
    const dungeonDay = settleDungeonDay({
      members,
      squads,
      rngState,
      atGameMinutes: nextAt,
      emit: (text) => collector.push(nextAt, '下本', text),
    });
    members = dungeonDay.members;
    rngState = dungeonDay.rngState;
    lastDungeonRun = dungeonDay.lastReport ?? lastDungeonRun;

    // 外快结算(自动层,短日志):打工/野团小队的个人金收入(GLOSSARY:个人金)
    const externalDay = settleExternalDay({
      members,
      squads,
      atGameMinutes: nextAt,
      emit: (text) => collector.push(nextAt, '经济', text),
    });
    members = externalDay.members;

    // 战场结算(自动层,T16,短日志 + 结果卡):战场队的逐场胜负与荣誉进账
    // (军衔晋升在下方荣誉结算段按结算后的荣誉账本推导,与首杀入墙同一编排)
    const honorCareerAtDayStart = honor.career;
    const battlefieldDay = settleBattlefieldDay({
      members,
      squads,
      honor,
      rngState,
      atGameMinutes: nextAt,
      emit: (text) => collector.push(nextAt, '战场', text),
    });
    members = battlefieldDay.members;
    honor = battlefieldDay.honor;
    rngState = battlefieldDay.rngState;
    lastBattlefieldReport = battlefieldDay.lastReport ?? lastBattlefieldReport;

    if (nextAt === nextWeekAt) {
      // 团本夜(计划层):开团安排在周边界整夜结算(直播视图数据 + 战斗日志);
      // 夜结束安排即清空 —— 团本 CD = 游戏周,下周重新开团
      if (raidPlan !== undefined) {
        const raidNight = settleRaidNight({
          members,
          squads,
          vault,
          economy,
          renownPoints,
          plan: raidPlan,
          rngState,
          atGameMinutes: nextAt,
          repairCostFactor: repairCostFactor(world),
          // 当周目标对自动/手动开团的夜一律生效(带新/farm/推进的钩子在结算内)
          goal:
            weeklyPlan === undefined ? undefined : WEEKLY_GOAL_BY_ID.get(weeklyPlan.goal),
          emit: (text) => collector.push(nextAt, '团本', text),
        });
        members = raidNight.members;
        vault = raidNight.vault;
        economy = raidNight.economy;
        renownPoints = raidNight.renownPoints;
        rngState = raidNight.rngState;
        lastRaidNight = raidNight.report ?? lastRaidNight;
        raidPlan = undefined;
        tonightReport = raidNight.report;
      }
      collector.push(nextAt, '周更', `第 ${gameWeek(nextAt)} 周开始,团本 CD 已重置。`);
      // 自动层照周计划为本周开团(T15,计划层):每周夜结算后重排,
      // 会长不操作公会照常运转;暂缓/失效记一条事件,条件满足自动恢复
      if (weeklyPlan !== undefined && raidPlan === undefined) {
        raidPlan = autoOpenPerWeeklyPlan(weeklyPlan, members, squads, nextAt, collector);
      }
    }

    // ———— 声望与荣誉(T12;GLOSSARY:声望等级/荣誉墙/名人堂)————

    // 冷板凳计数:已有小队的公会里,未编入任何小队的团员待命日数 +1(编入即清零)
    members = accrueBenchDays(members, squads);

    // 稀有陈列:今日穿上的紫装(5 人本 + 团本夜)逐件入墙,事件可追溯
    const rareRecords: readonly RareDropRecord[] = [
      ...dungeonDay.rareDrops
        .filter((entry) => entry.outcome.equipped)
        .map((entry) => ({
          slot: entry.outcome.slot,
          quality: entry.outcome.quality,
          itemLevel: entry.outcome.itemLevel,
          holder: entry.outcome.assignedTo ?? '?',
          source: entry.source,
          atGameMinutes: nextAt,
        })),
      ...(tonightReport !== undefined ? rareDropsFromRaidNight(tonightReport) : []),
    ];
    if (rareRecords.length > 0) {
      honorWall = { ...honorWall, rareDrops: [...honorWall.rareDrops, ...rareRecords] };
      for (const record of rareRecords) {
        collector.push(
          nextAt,
          '声望',
          `稀有入墙:${record.quality}·${record.slot}(装等 ${record.itemLevel})→ ${record.holder}(${record.source})。`,
        );
      }
    }

    const rungBefore = renownRung(renownPoints);

    // 首杀(GLOSSARY:本会首次击杀某团本首领):徽章入墙(带日期)+ 声望加分
    if (tonightReport !== undefined) {
      const firstKills = firstKillsFromRaidNight(tonightReport, honorWall);
      if (firstKills.badges.length > 0) {
        honorWall = { ...honorWall, firstKills: [...honorWall.firstKills, ...firstKills.badges] };
        renownPoints += firstKills.points;
        // 逐徽章分值按内容表取(同一夜同一团本 ⇒ 每枚同值);不用总分的除法分摊 ——
        // 非整除内容(如 14 分 3 杀)会在事件文案里出现小数(评审修复)
        const perKill = firstKillPointsForRaidTier(RAID_BY_ID.get(tonightReport.raidId)?.tier ?? 1);
        for (const badge of firstKills.badges) {
          collector.push(
            nextAt,
            '声望',
            `首杀!「${badge.bossName}」(${badge.raidName})首次倒在本会刀下 —— 声望 +${perKill}。`,
          );
        }
      }
    }

    // 里程碑:状态刻度 + 当日信号;新达成者入墙 + 加分(同一里程碑只达成一次)
    const milestones = evaluateMilestones({
      members,
      vaultIncomeTotal: vault.incomeTotal,
      signals: {
        dungeonClearedToday: dungeonDay.clearedToday,
        raidClearedTonight: tonightReport?.cleared === true,
        purpleEquippedToday: rareRecords.length > 0,
      },
      earnedMilestoneIds: honorWall.milestones.map((record) => record.milestoneId),
    });
    if (milestones.length > 0) {
      honorWall = {
        ...honorWall,
        milestones: [
          ...honorWall.milestones,
          ...milestones.map((def) => ({ milestoneId: def.id, name: def.name, atGameMinutes: nextAt })),
        ],
      };
      for (const def of milestones) {
        renownPoints += def.points;
        collector.push(
          nextAt,
          '声望',
          `里程碑达成:「${def.name}」—— ${def.description}。声望 +${def.points}。`,
        );
      }
    }

    // 荣誉阶梯军衔晋升(T16,GLOSSARY:荣誉阶梯):生涯荣誉跨过门槛 ⇒ 军衔记录入墙
    // (同一日跨多阶则逐阶补记;兑换军装只花荣誉点、不动生涯荣誉,不降衔)
    const honorRungBefore = honorRankRung(honorCareerAtDayStart);
    const honorRungAfter = honorRankRung(honor.career);
    if (honorRungAfter > honorRungBefore) {
      const badges = [];
      for (let rung = honorRungBefore + 1; rung <= honorRungAfter; rung++) {
        const rank = honorRankOf(rung);
        badges.push({ rankId: rank.id, name: rank.name, atGameMinutes: nextAt });
        collector.push(
          nextAt,
          '战场',
          `军衔晋升:「${rank.name}」—— 生涯荣誉 ${honor.career}(荣誉阶梯第 ${rung + 1} 阶:${rank.blurb})`,
        );
      }
      honorWall = { ...honorWall, rankLadder: [...honorWall.rankLadder, ...badges] };
    }

    // 阶位提升:档位与星级可见;跨档时名册上限随之扩容(只升不降),档位解锁挖角一并公告
    const rungAfter = renownRung(renownPoints);
    if (rungAfter > rungBefore) {
      const beforeTier = renownStanding(rungBefore).tier;
      const afterStanding = renownStanding(rungAfter);
      const capAfter = rosterCapForRung(rungAfter);
      const parts = [`声望提升:${renownLabel(rungAfter)}(声望值 ${renownPoints})`];
      if (capAfter > rosterCap) {
        rosterCap = capAfter;
        parts.push(`名册上限扩至 ${rosterCap} 人`);
      }
      if (afterStanding.tier.poachUnlocked && !beforeTier.poachUnlocked) {
        parts.push('解锁挖角(可对背景公会出手)');
      }
      collector.push(nextAt, '声望', `${parts.join(',')}。`);
    }

    // 自动退会(DESIGN:忠诚过低或长期冷板凳):留台词与去向,入名人堂,除名清编
    for (const resignation of autoResignations(members)) {
      const entry = hallEntryFor(resignation.member, resignation.reason, nextAt);
      hallOfFame = [...hallOfFame, entry];
      members = members.filter((member) => member.id !== resignation.member.id);
      squads = removeFromSquads(squads, resignation.member.id);
      collector.push(
        nextAt,
        '退会',
        `「${resignation.member.name}」自动退会(${resignation.reason}):「${entry.farewell}」—— ${entry.destination}。功绩:${hallDeedsLine(entry)}。`,
      );
    }

    // ———— 虚拟服务器周结算(T13,GLOSSARY:服务器与对手)————
    // 在荣誉结算之后:玩家本夜战果已入荣誉墙,先判玩家的服务器首杀,
    // 再跑橡皮筋(竞争公会推进/超车)与排名 —— 同一边界玩家优先。
    if (nextAt === nextWeekAt) {
      const worldWeek = settleWorldWeek({
        world,
        honorWall,
        guildName: state.guild.name,
        atGameMinutes: nextAt,
        tonightKilledBossIds:
          tonightReport !== undefined
            ? tonightReport.bosses.filter((boss) => boss.killed).map((boss) => boss.bossId)
            : [],
        averageLevel: guildAverageLevel(members),
        averageItemLevel: guildAverageItemLevel(members),
      });
      world = worldWeek.world;
      for (const text of worldWeek.news) {
        collector.push(nextAt, '世界', text);
      }
    }
  }

  return {
    ...state,
    clockGameMinutes: target,
    rngState,
    members,
    squads,
    applicants,
    nextApplicationId,
    lastDungeonRun,
    honor,
    lastBattlefieldReport,
    vault,
    economy,
    renownPoints,
    raidPlan,
    weeklyPlan,
    lastRaidNight,
    honorWall,
    hallOfFame,
    rosterCap,
    world,
  };
}

/** 门面对象:封装当前状态,供装配层(UI)与测试驱动。 */
export class SimulationFacade {
  private _state: GameState;

  /**
   * @param seed 本局种子(建会名册与申请池生成)
   * @param guildName 公会名(缺省用默认名)
   * @param resumeState 从版本化存档恢复的状态(ADR-0003);给出时忽略 seed 与公会名
   */
  constructor(seed: number, guildName?: string, resumeState?: GameState) {
    this._state = resumeState ?? createInitialState(seed, guildName);
  }

  get state(): GameState {
    return this._state;
  }

  /** 处理一步输入(指令 + 时间增量),推进内部状态并返回本步事件。 */
  dispatch(input: SimInput): StepOutput {
    const output = step(this._state, input);
    this._state = output.state;
    return output;
  }

  /**
   * 整体替换内部状态:装配层导入存档后的恢复入口(验收标准 2)。
   * 只换状态、不产生事件(日志是门面输出,不在存档内;UI 侧自行清空滚动日志)。
   */
  restore(state: GameState): void {
    this._state = state;
  }
}
