import { DAILY_FLAVOR_POOL } from '../content/daily-flavor';
import { COMP } from '../content/comp';
import { LEVELING_MAP_BY_ID } from '../content/maps';
import type { GuildCommand } from './commands';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK, gameDay, gameWeek } from './clock';
import type { SimEvent, SimEventKind } from './events';
import { guildAverageLevel } from './roster';
import { settleLevelingDay, squadLevelingMap } from './leveling';
import { generateApplicantPool } from './recruit';
import { pickOne } from './rng';
import { createInitialState, normalizeGuildName, type GameState, type Member, type Squad } from './state';

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
      const member: Member = { id: state.nextMemberId, isChairman: false, ...applicant.profile };
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
      return {
        ...state,
        members: state.members.filter((m) => m.id !== command.memberId),
        // 淘汰同时清编:人走队清,小队不悬挂已离会团员
        squads: removeFromSquads(state.squads, command.memberId),
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
      // 解锁校验只发生在安排时刻:公会平均等级达到门槛才可进驻
      // (安排之后平均等级回落不打断进行中的练级)
      if (guildAverageLevel(state.members) < map.unlockAverageLevel) {
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
  }
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
  let applicants = state.applicants;
  let nextApplicationId = state.nextApplicationId;

  // 逐个跨越的边界结算;游戏周边界必是游戏日边界(分钟数整除)。
  // 日界结算顺序固定:日更文案 → 申请池刷新 → 练级/休整(自动层)→(周更)。
  for (;;) {
    const nextDayAt = (Math.floor(cursor / GAME_MINUTES_PER_DAY) + 1) * GAME_MINUTES_PER_DAY;
    const nextWeekAt = (Math.floor(cursor / GAME_MINUTES_PER_WEEK) + 1) * GAME_MINUTES_PER_WEEK;
    const nextAt = Math.min(nextDayAt, nextWeekAt);
    if (nextAt > target) {
      break;
    }
    cursor = nextAt;

    const [flavor, afterFlavor] = pickOne(rngState, DAILY_FLAVOR_POOL);
    rngState = afterFlavor;
    collector.push(nextAt, '日更', `第 ${gameDay(nextAt)} 天:${flavor}`);

    // 申请池每日刷新:未处理的申请全部作废,按当日声望规格重生成(GLOSSARY:申请池)
    const pool = generateApplicantPool(rngState, state.reputation, members, nextApplicationId);
    rngState = pool.rngState;
    applicants = pool.applicants;
    nextApplicationId = pool.nextApplicationId;
    collector.push(nextAt, '招募', `申请池刷新:${applicants.length} 名冒险者递来了申请。`);

    // 练级结算(自动层,静默计数):进驻地图的队员成长与积劳,其余全员休整
    const day = settleLevelingDay(members, state.squads, rngState);
    members = day.members;
    rngState = day.rngState;

    if (nextAt === nextWeekAt) {
      collector.push(nextAt, '周更', `第 ${gameWeek(nextAt)} 周开始,团本 CD 已重置。`);
    }
  }

  return { ...state, clockGameMinutes: target, rngState, members, applicants, nextApplicationId };
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
}
