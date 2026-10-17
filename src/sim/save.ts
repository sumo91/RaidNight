/**
 * 本地存档格式(ADR-0003):买断单机、无后端,存档为本地文件,
 * 支持手动导出/导入,格式自第一版起版本化、升版走迁移。
 *
 * 本模块只有纯函数:编码/解码/迁移,不接触任何存储介质 ——
 * localStorage 自动存档与导出/导入文件共用同一编码,
 * 介质读写(存储、下载、上传)一律在装配层(src/main.ts)。
 * 数据模型按「将来可同步」设计:状态含种子与随机链,基于时间戳推进、离线结算幂等。
 */

import type { GameState } from './state';

/** 存档种类标记:v4 起写入封皮,导入时先验校验(不是本游戏的文件 → 拒绝)。 */
export const SAVE_KIND = 'wowidle-save';

/**
 * 当前存档格式版本。
 * 版本史:
 * - v1(T4 及以前):无经验维度;
 * - v2(T5):团员含经验(experience),小队活动(activity)可缺省;
 * - v3(T6):活动含下本(dungeon),状态新增 lastDungeonRun(可缺省);
 * - v4(T7):封皮新增 kind 标记(导出/导入文件先验校验),状态结构无变化。
 */
export const SAVE_VERSION = 4;

/** 版本化存档封皮:v1–v3 的本机旧档没有 kind,读入时视为 legacy。 */
export interface SaveFile {
  readonly kind?: typeof SAVE_KIND;
  readonly version: number;
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
};

/** 编码:状态 → 存档文本(localStorage 值与导出文件内容共用)。 */
export function encodeSave(state: GameState): string {
  return JSON.stringify({ kind: SAVE_KIND, version: SAVE_VERSION, state } satisfies SaveFile);
}

/**
 * 解码:存档文本 → 状态;损坏、非本游戏文件、未知(含未来)版本、
 * 结构不完整一律返回 null(调用方回退新档或提示导入失败,不中断游戏)。
 */
export function decodeSave(raw: string): GameState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const file = parsed as { kind?: unknown; version?: unknown; state?: unknown };
  // kind 缺省 = v1–v3 本机旧档(可迁移);给出了但不匹配 = 不是本游戏的存档
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
  return looksLikeGameState(state) ? state : null;
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
    typeof state.reputation !== 'number'
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
        Array.isArray(member.gear),
    ) &&
    state.squads.every((squad) => typeof squad.id === 'number' && Array.isArray(squad.memberIds)) &&
    state.applicants.every((applicant) => typeof applicant.applicationId === 'number')
  );
}
