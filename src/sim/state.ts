import { GUILD_NAME_MAX_LENGTH } from './commands';

/**
 * 团员:名册中的一名在册成员。
 * T1 仅作占位(名册为空);后续工单补全职业/专精/职能/装备/三维状态等。
 */
export interface Member {
  readonly id: number;
  readonly name: string;
}

/** 公会信息:玩家管理的核心成长主体。 */
export interface GuildInfo {
  readonly name: string;
}

/**
 * 游戏状态:门面的状态部分,纯数据、可序列化。
 * 确定性的关键:种子与随机链状态(rngState)都在状态内。
 */
export interface GameState {
  /** 本局种子:决定一切随机 */
  readonly seed: number;
  /** 种子随机源链状态(见 sim/rng.ts;可序列化、可重放) */
  readonly rngState: number;
  /** 游戏时钟:自建会起累计的游戏分钟 */
  readonly clockGameMinutes: number;
  readonly guild: GuildInfo;
  /** 名册:T1 恒为空,后续工单引入团员 */
  readonly members: readonly Member[];
  /** 下一个事件序号 */
  readonly nextEventSeq: number;
}

export const DEFAULT_GUILD_NAME = '星盾公会';

/** 初始状态:建会时刻,游戏时间为 0。 */
export function createInitialState(seed: number, guildName?: string): GameState {
  const seed32 = seed | 0;
  const name = guildName === undefined ? DEFAULT_GUILD_NAME : normalizeGuildName(guildName);
  return {
    seed: seed32,
    rngState: seed32,
    clockGameMinutes: 0,
    guild: { name: name ?? DEFAULT_GUILD_NAME },
    members: [],
    nextEventSeq: 1,
  };
}

/** 公会名规范化:去首尾空白 + 截断;非法(空)返回 undefined。规则只存在于 sim。 */
export function normalizeGuildName(raw: string): string | undefined {
  const name = raw.trim().slice(0, GUILD_NAME_MAX_LENGTH);
  return name === '' ? undefined : name;
}
