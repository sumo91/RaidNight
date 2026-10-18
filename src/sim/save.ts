/**
 * 本地存档格式(ADR-0003):买断单机、无后端,存档为本地文件,
 * 支持手动导出/导入,格式自第一版起版本化、升版走迁移。
 *
 * 本模块只有纯函数:编码/解码/迁移,不接触任何存储介质 ——
 * localStorage 自动存档与导出/导入文件共用同一编码,
 * 介质读写(存储、下载、上传)一律在装配层(src/main.ts)。
 * 数据模型按「将来可同步」设计:状态含种子与随机链,基于时间戳推进、离线结算幂等。
 */

import { VAULT } from '../content/economy';
import { createEmptyHonorWall, createInitialEconomy, type GameState } from './state';

/** 存档种类标记:v4 起写入封皮,导入时先验校验(不是本游戏的文件 → 拒绝)。 */
export const SAVE_KIND = 'wowidle-save';

/**
 * 当前存档格式版本。
 * 版本史:
 * - v1(T4 及以前):无经验维度;
 * - v2(T5):团员含经验(experience),小队活动(activity)可缺省;
 * - v3(T6):活动含下本(dungeon),状态新增 lastDungeonRun(可缺省);
 * - v4(T7):封皮新增 kind 标记(导出/导入文件先验校验),状态结构无变化;
 * - v5(T9):封皮新增 savedAtMs(存档落盘的现实毫秒时间戳,离线结算的起测点,
 *   ADR-0003「基于时间戳推进、离线结算幂等」;可缺省 = 0,不触发补结算);
 * - v6(T10):状态新增公会金库 vault(最小金库:余额 + 修理支出;旧档按建会
 *   起始余额补);开团安排 raidPlan 与最近团本夜 lastRaidNight 可缺省;
 * - v7(T11):经济面 —— 团员新增个人金(personalGold)与 DKP(dkp),金库新增
 *   历史收入累计(incomeTotal),状态新增经济 economy(分配制度/自肥,旧档
 *   补建会默认:会长裁量制、不自肥);小队活动含外快(carry/wildRaid)。
 * - v8(T12):声望与荣誉面 —— 状态新增声望值(renownPoints,替换 v7 的桩值
 *   reputation 0-100 刻度,1:1 结转)、荣誉墙 honorWall(首杀/里程碑/稀有)
 *   与名人堂 hallOfFame;团员新增功绩统计(bossKills/rareLootWon)、入册时刻
 *   (joinedAtGameMinutes)与冷板凳计数(benchDays),旧档一律从 0 补
 *   (申请人画像同步补 —— 招入时画像原样转正,缺字段会在结算中变 NaN)。
 */
export const SAVE_VERSION = 8;

/** 版本化存档封皮:v1–v3 的本机旧档没有 kind,读入时视为 legacy。 */
export interface SaveFile {
  readonly kind?: typeof SAVE_KIND;
  readonly version: number;
  /**
   * 存档落盘时刻(现实毫秒时间戳)。由装配层写入与解读(现实时钟只存在于
   * src/main.ts);sim 只存取不解读 —— 0/缺省表示「不带时间基准」,
   * 恢复时不做离线补结算。
   */
  readonly savedAtMs?: number;
  readonly state: GameState;
}

/** 单步迁移:vN → vN+1,只补缺省字段、不丢数据。 */
type Migration = (state: GameState) => GameState;

/** 迁移链:键 = 迁移前版本。升版时在此追加一步,不改动历史步骤。 */
const MIGRATIONS: Readonly<Record<number, Migration>> = {
  // v1 → v2:老档团员补经验维度(0)
  1: (state) => ({
    ...state,
    members: state.members.map((member) => ({ ...member, experience: member.experience ?? 0 })),
  }),
  // v2 → v3:下本相关字段全部可缺省(lastDungeonRun 缺省 = 尚未下过本)
  2: (state) => ({ ...state, lastDungeonRun: state.lastDungeonRun ?? undefined }),
  // v3 → v4:封皮级变化(新增 kind),状态无必补字段
  3: (state) => state,
  // v4 → v5:封皮级变化(新增 savedAtMs 时间基准),状态无必补字段
  4: (state) => state,
  // v5 → v6:补最小金库(余额按建会起始值;修理支出从 0 计)
  5: (state) => ({
    ...state,
    vault: state.vault ?? { gold: VAULT.startingGold, repairSpent: 0 },
  }),
  // v6 → v7:补经济面(个人金/DKP 从 0 起;金库收入累计从 0 计;经济补建会默认)。
  // 申请人画像(personalGold/dkp)同步补:招入时画像原样转正,缺字段会随结算变 NaN
  // 并在下次落盘后拒档(评审修复:补齐 v6→v7 的同型缺口)
  6: (state) => ({
    ...state,
    members: Array.isArray(state.members)
      ? state.members.map((member) => ({
          ...member,
          personalGold: member.personalGold ?? 0,
          dkp: member.dkp ?? 0,
        }))
      : state.members,
    applicants: Array.isArray(state.applicants)
      ? state.applicants.map((applicant) => ({
          ...applicant,
          profile: {
            ...applicant.profile,
            personalGold: applicant.profile.personalGold ?? 0,
            dkp: applicant.profile.dkp ?? 0,
          },
        }))
      : state.applicants,
    vault:
      state.vault !== undefined
        ? { ...state.vault, incomeTotal: state.vault.incomeTotal ?? 0 }
        : { gold: VAULT.startingGold, repairSpent: 0, incomeTotal: 0 },
    economy: state.economy ?? createInitialEconomy(state.clockGameMinutes ?? 0),
  }),
  // v7 → v8:补声望与荣誉面(功绩/入册时刻/冷板凳从 0 起;荣誉墙与名人堂为空;
  // 旧声望是 T3 桩值刻度 —— 桩值只减不涨且建会为 0,真实 v7 档恒为 0,1:1 结转不亏)。
  // 申请人画像(bossKills/rareLootWon)同步补:招入即转正,缺字段在击杀/换装结算中
  // 变 NaN,NaN 落盘成 null 后 looksLikeGameState 拒档,整个存档永久不可读(评审修复)
  7: (state) => {
    const legacy = state as GameState & { reputation?: number };
    const { reputation: _legacyReputation, ...rest } = legacy;
    return {
      ...rest,
      renownPoints: Math.max(0, Math.round(_legacyReputation ?? 0)),
      honorWall: state.honorWall ?? createEmptyHonorWall(),
      hallOfFame: state.hallOfFame ?? [],
      members: Array.isArray(state.members)
        ? state.members.map((member) => ({
            ...member,
            bossKills: member.bossKills ?? 0,
            rareLootWon: member.rareLootWon ?? 0,
            joinedAtGameMinutes: member.joinedAtGameMinutes ?? 0,
            benchDays: member.benchDays ?? 0,
          }))
        : state.members,
      applicants: Array.isArray(state.applicants)
        ? state.applicants.map((applicant) => ({
            ...applicant,
            profile: {
              ...applicant.profile,
              bossKills: applicant.profile.bossKills ?? 0,
              rareLootWon: applicant.profile.rareLootWon ?? 0,
            },
          }))
        : state.applicants,
    };
  },
};

/** 编码:状态 → 存档文本(localStorage 值与导出文件内容共用)。 */
export function encodeSave(state: GameState, savedAtMs = 0): string {
  return JSON.stringify({ kind: SAVE_KIND, version: SAVE_VERSION, savedAtMs, state } satisfies SaveFile);
}

/** 解码结果:状态 + 封皮携带的存档时间基准(离线结算的起测点)。 */
export interface DecodedSave {
  readonly state: GameState;
  /** 存档落盘时刻(现实毫秒);0 = 存档不带时间基准(旧档/缺省) */
  readonly savedAtMs: number;
}

/**
 * 解码:存档文本 → 状态 + 存档时间基准;损坏、非本游戏文件、
 * 未知(含未来)版本、结构不完整一律返回 null(调用方回退新档或提示导入失败)。
 * 离线结算(装配层)需要封皮里的 savedAtMs,故经本函数取完整封皮。
 */
export function decodeSaveEnvelope(raw: string): DecodedSave | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const file = parsed as { kind?: unknown; version?: unknown; savedAtMs?: unknown; state?: unknown };
  // kind 缺省 = v1–v4 本机旧档(可迁移);给出了但不匹配 = 不是本游戏的存档
  if (file.kind !== undefined && file.kind !== SAVE_KIND) {
    return null;
  }
  if (typeof file.version !== 'number' || !Number.isInteger(file.version)) {
    return null;
  }
  // 未知版本不猜:比当前新的版本(未来档)与 0/负数一律拒绝
  if (file.version < 1 || file.version > SAVE_VERSION) {
    return null;
  }
  if (typeof file.state !== 'object' || file.state === null) {
    return null;
  }
  let state = file.state as GameState;
  for (let version = file.version; version < SAVE_VERSION; version++) {
    state = MIGRATIONS[version]!(state);
  }
  if (!looksLikeGameState(state)) {
    return null;
  }
  // 时间基准防御:非有限数或负数(时钟回拨的怪档)一律按「无基准」处理
  const savedAtMs =
    typeof file.savedAtMs === 'number' && Number.isFinite(file.savedAtMs) && file.savedAtMs > 0
      ? file.savedAtMs
      : 0;
  return { state, savedAtMs };
}

/**
 * 解码:存档文本 → 状态(只要状态不要时间基准时的便捷入口;
 * 规则与 decodeSaveEnvelope 完全一致)。
 */
export function decodeSave(raw: string): GameState | null {
  return decodeSaveEnvelope(raw)?.state ?? null;
}

/** 结构防御:关键字段缺失/类型不对视为损坏(迁移后的最终形态必须完整)。 */
function looksLikeGameState(state: GameState): boolean {
  if (
    typeof state.seed !== 'number' ||
    typeof state.rngState !== 'number' ||
    typeof state.clockGameMinutes !== 'number' ||
    typeof state.nextMemberId !== 'number' ||
    typeof state.nextSquadId !== 'number' ||
    typeof state.nextApplicationId !== 'number' ||
    typeof state.nextEventSeq !== 'number' ||
    typeof state.guild !== 'object' ||
    state.guild === null ||
    typeof state.guild.name !== 'string' ||
    typeof state.rosterCap !== 'number' ||
    typeof state.renownPoints !== 'number' ||
    typeof state.honorWall !== 'object' ||
    state.honorWall === null ||
    !Array.isArray(state.honorWall.firstKills) ||
    !Array.isArray(state.honorWall.milestones) ||
    !Array.isArray(state.honorWall.rareDrops) ||
    !Array.isArray(state.hallOfFame) ||
    typeof state.vault !== 'object' ||
    state.vault === null ||
    typeof state.vault.gold !== 'number' ||
    typeof state.vault.repairSpent !== 'number' ||
    typeof state.vault.incomeTotal !== 'number' ||
    typeof state.economy !== 'object' ||
    state.economy === null ||
    typeof state.economy.system !== 'string' ||
    typeof state.economy.selfDealing !== 'boolean' ||
    typeof state.economy.selfDealtCount !== 'number'
  ) {
    return false;
  }
  if (!Array.isArray(state.members) || !Array.isArray(state.squads) || !Array.isArray(state.applicants)) {
    return false;
  }
  return (
    state.members.every(
      (member) =>
        typeof member.id === 'number' &&
        typeof member.name === 'string' &&
        typeof member.level === 'number' &&
        typeof member.experience === 'number' &&
        typeof member.personalGold === 'number' &&
        typeof member.dkp === 'number' &&
        typeof member.bossKills === 'number' &&
        typeof member.rareLootWon === 'number' &&
        typeof member.joinedAtGameMinutes === 'number' &&
        typeof member.benchDays === 'number' &&
        Array.isArray(member.gear),
    ) &&
    state.squads.every((squad) => typeof squad.id === 'number' && Array.isArray(squad.memberIds)) &&
    state.applicants.every((applicant) => typeof applicant.applicationId === 'number')
  );
}
