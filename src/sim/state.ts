import { GUILD_NAME_MAX_LENGTH } from './commands';
import { generateFoundingRoster } from './member-gen';
import type { GearSlot, Quality } from '../content/gear';

/**
 * 团员:名册中的一名在册成员(GLOSSARY)。
 * 全维度:职业 + 专精、等级、8 部位装备(装等由派生函数计算)、
 * 三维状态(心情/忠诚/疲劳)、出勤画像、性格标签(1–2)、技艺评级。
 * 引用内容表处只存 id(数据驱动:改文案不动存档)。
 */
export interface Member {
  readonly id: number;
  readonly name: string;
  /** 是否会长角色(会长在名册中的自有角色,GLOSSARY) */
  readonly isChairman: boolean;
  readonly classId: string;
  readonly specId: string;
  readonly level: number;
  /** 8 部位装备,顺序同 content/gear.GEAR_SLOTS */
  readonly gear: readonly GearItem[];
  /** 心情(0-100) */
  readonly mood: number;
  /** 忠诚(0-100);会长角色恒为 100 */
  readonly loyalty: number;
  /** 疲劳(0-100) */
  readonly fatigue: number;
  /** 出勤画像:风格 + 基础出勤率 */
  readonly attendance: AttendanceProfile;
  /** 性格标签 id(1–2 个) */
  readonly traits: readonly string[];
  /** 技艺评级档位 id */
  readonly skillTierId: string;
}

/** 单件装备:部位 + 品质 + 装等(物品表见后续装备工单)。 */
export interface GearItem {
  readonly slot: GearSlot;
  readonly quality: Quality;
  readonly itemLevel: number;
}

/** 出勤画像:风格 id(content/attendance)+ 基础出勤率(0-100)。 */
export interface AttendanceProfile {
  readonly styleId: string;
  readonly baseRate: number;
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
  /** 本局种子:决定一切随机(含建会名册生成) */
  readonly seed: number;
  /** 种子随机源链状态(见 sim/rng.ts;可序列化、可重放) */
  readonly rngState: number;
  /** 游戏时钟:自建会起累计的游戏分钟 */
  readonly clockGameMinutes: number;
  readonly guild: GuildInfo;
  /** 名册:建会时生成(会长角色 + 初始团员),后续工单经指令增减 */
  readonly members: readonly Member[];
  /** 下一个团员 id(生成与招募共用) */
  readonly nextMemberId: number;
  /** 下一个事件序号 */
  readonly nextEventSeq: number;
}

export const DEFAULT_GUILD_NAME = '星盾公会';

/**
 * 初始状态:建会时刻,游戏时间为 0。
 * 名册在此时生成:同一种子 ⇒ 同一批团员(生成走种子随机链,链状态存回 GameState)。
 */
export function createInitialState(seed: number, guildName?: string): GameState {
  const seed32 = seed | 0;
  const name = guildName === undefined ? DEFAULT_GUILD_NAME : normalizeGuildName(guildName);
  const roster = generateFoundingRoster(seed32);
  return {
    seed: seed32,
    rngState: roster.rngState,
    clockGameMinutes: 0,
    guild: { name: name ?? DEFAULT_GUILD_NAME },
    members: roster.members,
    nextMemberId: roster.nextMemberId,
    nextEventSeq: 1,
  };
}

/** 公会名规范化:去首尾空白 + 截断;非法(空)返回 undefined。规则只存在于 sim。 */
export function normalizeGuildName(raw: string): string | undefined {
  const name = raw.trim().slice(0, GUILD_NAME_MAX_LENGTH);
  return name === '' ? undefined : name;
}
