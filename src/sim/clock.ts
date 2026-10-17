/**
 * 游戏时钟:整个模拟运行于游戏时间(ADR-0004)。
 * 一切 CD、排期、成长与反馈节奏均以游戏时间计,不设现实时间硬门。
 */

/** 1 游戏周 = 7 游戏日。 */
export const GAME_DAYS_PER_WEEK = 7;

/** 1 游戏日 = 24 × 60 游戏分钟。 */
export const GAME_MINUTES_PER_DAY = 24 * 60;

/** 1 游戏周的分钟数。 */
export const GAME_MINUTES_PER_WEEK = GAME_DAYS_PER_WEEK * GAME_MINUTES_PER_DAY;

/**
 * 单一可调常量:1 现实天 = 1 游戏周(ADR-0004,调优方向可以更快)。
 * 现实时间只在装配层(src/main.ts)换算为游戏时间增量,门面本身不接受现实时间。
 */
export const REAL_MS_PER_REAL_DAY = 86_400_000;
export const GAME_MINUTES_PER_REAL_MS = GAME_MINUTES_PER_WEEK / REAL_MS_PER_REAL_DAY;

/** 游戏周内的日名(第几周的星期几)。 */
export const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;

/** 自建会起的天序(0 起)。 */
export function gameDayIndex(minutes: number): number {
  return Math.floor(minutes / GAME_MINUTES_PER_DAY);
}

/** 第几个游戏日(1 起)。 */
export function gameDay(minutes: number): number {
  return gameDayIndex(minutes) + 1;
}

/** 第几个游戏周(1 起)。 */
export function gameWeek(minutes: number): number {
  return Math.floor(minutes / GAME_MINUTES_PER_WEEK) + 1;
}

/** 游戏周内的星期序号(0 = 周一)。 */
export function dayOfWeek(minutes: number): number {
  return gameDayIndex(minutes) % GAME_DAYS_PER_WEEK;
}

/** 当日已过的游戏分钟(0..1439)。 */
export function minuteOfDay(minutes: number): number {
  return ((minutes % GAME_MINUTES_PER_DAY) + GAME_MINUTES_PER_DAY) % GAME_MINUTES_PER_DAY;
}

/** 现实毫秒 → 游戏分钟(浮点;装配层负责取整以保证确定性)。 */
export function realMsToGameMinutes(realMs: number): number {
  return realMs * GAME_MINUTES_PER_REAL_MS;
}

/**
 * 游戏分钟 → 现实毫秒(同一比率常量的逆换算)。
 * 只作展示换算(倒计时/离线摘要的「现实还需多久」);不得用于推进游戏时间 ——
 * 现实时间进入模拟的唯一路径仍是装配层的 realMsToGameMinutes + 门面增量。
 */
export function gameMinutesToRealMs(gameMinutes: number): number {
  return gameMinutes / GAME_MINUTES_PER_REAL_MS;
}
