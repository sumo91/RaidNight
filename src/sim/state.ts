import { GUILD_NAME_MAX_LENGTH } from './commands';
import { generateFoundingRoster } from './member-gen';
import { generateApplicantPool } from './recruit';
import { RECRUIT } from '../content/recruit';
import type { GearSlot, Quality } from '../content/gear';

/**
 * 团员画像:除 id 与会长标记外的全部团员维度。
 * 在册团员(Member)与申请人(Applicant)共用 —— 申请人招入时画像原样转正。
 */
export interface MemberProfile {
  readonly name: string;
  readonly classId: string;
  readonly specId: string;
  readonly level: number;
  /** 当前等级内已累计的经验(升级公式见 sim/leveling.ts) */
  readonly experience: number;
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

/**
 * 团员:名册中的一名在册成员(GLOSSARY)。
 * 全维度见 MemberProfile;引用内容表处只存 id(数据驱动:改文案不动存档)。
 */
export interface Member extends MemberProfile {
  readonly id: number;
  /** 是否会长角色(会长在名册中的自有角色,GLOSSARY) */
  readonly isChairman: boolean;
}

/**
 * 申请:申请池中的一份求职申请(GLOSSARY:申请池)。
 * 画像在每日刷新时按池子规格预生成;招入时才分配团员 id。
 */
export interface Applicant {
  /** 申请编号(与团员 id 相互独立的空间) */
  readonly applicationId: number;
  /** 申请人完整画像 */
  readonly profile: MemberProfile;
}

/**
 * 小队:5 人制的基本编组单位(GLOSSARY);一切活动的出勤以小队为原子。
 * 队内只存团员 id(顺序即编入顺序);职能结构与光环是派生量(sim/comp.ts)。
 */
export interface Squad {
  readonly id: number;
  readonly memberIds: readonly number[];
  /** 当前活动安排;缺省 = 待命休整(疲劳自然恢复,见 sim/leveling.ts) */
  readonly activity?: SquadActivity;
}

/** 小队活动:练级(进驻地图);后续工单(5 人本等)在此扩展类型。 */
export type SquadActivity =
  /** 练级:进驻某张练级地图,自动层逐日结算 */
  | { readonly type: 'leveling'; readonly mapId: string };

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
  /**
   * 声望(0-100):驱动申请池的数量与质量(GLOSSARY:声望等级)。
   * 本票为桩值(T12 接声望系统真值),只读不涨。
   */
  readonly reputation: number;
  /** 名册上限:自 6 人起步;扩容与声望联动在 T12。 */
  readonly rosterCap: number;
  /** 名册:建会时生成(会长角色 + 初始团员),经招募/淘汰指令增减 */
  readonly members: readonly Member[];
  /** 下一个团员 id(生成与招募共用) */
  readonly nextMemberId: number;
  /** 编成:小队列表(建会时为空;最多 maxSquads 支,见 content/comp) */
  readonly squads: readonly Squad[];
  /** 下一个小队 id */
  readonly nextSquadId: number;
  /** 申请池:每游戏日刷新(含建会当日的初始池) */
  readonly applicants: readonly Applicant[];
  /** 下一个申请编号 */
  readonly nextApplicationId: number;
  /** 下一个事件序号 */
  readonly nextEventSeq: number;
}

export const DEFAULT_GUILD_NAME = '星盾公会';

/**
 * 初始状态:建会时刻,游戏时间为 0。
 * 名册与当日申请池在此时生成:同一种子 ⇒ 同一批团员与同一池申请
 * (生成走种子随机链,链状态存回 GameState)。
 */
export function createInitialState(seed: number, guildName?: string): GameState {
  const seed32 = seed | 0;
  const name = guildName === undefined ? DEFAULT_GUILD_NAME : normalizeGuildName(guildName);
  const roster = generateFoundingRoster(seed32);
  // 建会当日就有申请池可浏览(每日刷新从下一个游戏日边界开始)
  const pool = generateApplicantPool(roster.rngState, RECRUIT.stubReputation, roster.members, 1);
  return {
    seed: seed32,
    rngState: pool.rngState,
    clockGameMinutes: 0,
    guild: { name: name ?? DEFAULT_GUILD_NAME },
    reputation: RECRUIT.stubReputation,
    rosterCap: RECRUIT.baseRosterCap,
    members: roster.members,
    nextMemberId: roster.nextMemberId,
    squads: [],
    nextSquadId: 1,
    applicants: pool.applicants,
    nextApplicationId: pool.nextApplicationId,
    nextEventSeq: 1,
  };
}

/** 公会名规范化:去首尾空白 + 截断;非法(空)返回 undefined。规则只存在于 sim。 */
export function normalizeGuildName(raw: string): string | undefined {
  const name = raw.trim().slice(0, GUILD_NAME_MAX_LENGTH);
  return name === '' ? undefined : name;
}
