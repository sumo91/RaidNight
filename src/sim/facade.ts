import { DAILY_FLAVOR_POOL } from '../content/daily-flavor';
import type { GuildCommand } from './commands';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK, gameDay, gameWeek } from './clock';
import type { SimEvent, SimEventKind } from './events';
import { generateApplicantPool } from './recruit';
import { pickOne } from './rng';
import { createInitialState, normalizeGuildName, type GameState, type Member } from './state';

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
      };
    }
  }
}

function advanceClock(state: GameState, delta: number, collector: EventCollector): GameState {
  if (delta <= 0) {
    return state;
  }
  const target = state.clockGameMinutes + delta;
  let cursor = state.clockGameMinutes;
  let rngState = state.rngState;
  let applicants = state.applicants;
  let nextApplicationId = state.nextApplicationId;

  // 逐个跨越的边界结算;游戏周边界必是游戏日边界(分钟数整除)。
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
    const pool = generateApplicantPool(rngState, state.reputation, state.members, nextApplicationId);
    rngState = pool.rngState;
    applicants = pool.applicants;
    nextApplicationId = pool.nextApplicationId;
    collector.push(nextAt, '招募', `申请池刷新:${applicants.length} 名冒险者递来了申请。`);

    if (nextAt === nextWeekAt) {
      collector.push(nextAt, '周更', `第 ${gameWeek(nextAt)} 周开始,团本 CD 已重置。`);
    }
  }

  return { ...state, clockGameMinutes: target, rngState, applicants, nextApplicationId };
}

/** 门面对象:封装当前状态,供装配层(UI)与测试驱动。 */
export class SimulationFacade {
  private _state: GameState;

  constructor(seed: number, guildName?: string) {
    this._state = createInitialState(seed, guildName);
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
