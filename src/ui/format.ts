import { GAME_MINUTES_PER_DAY, WEEKDAY_NAMES, dayOfWeek, gameWeek, minuteOfDay } from '../sim/clock';

/** 展示格式化:纯展示,不含任何业务规则。 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function clockParts(minutes: number): { week: number; weekday: string; hhmm: string } {
  const time = minuteOfDay(minutes);
  return {
    week: gameWeek(minutes),
    weekday: WEEKDAY_NAMES[dayOfWeek(minutes)] ?? '周一',
    hhmm: `${pad2(Math.floor(time / 60))}:${pad2(time % 60)}`,
  };
}

/** 头部时钟。例:「第4周 · 周五 03:16」 */
export function formatGameClock(minutes: number): string {
  const { week, weekday, hhmm } = clockParts(minutes);
  return `第${week}周 · ${weekday} ${hhmm}`;
}

/** 日志时间戳。例:「第4周周五 03:16」 */
export function formatGameStamp(minutes: number): string {
  const { week, weekday, hhmm } = clockParts(minutes);
  return `第${week}周${weekday} ${hhmm}`;
}

/** 游戏时长(分钟 →「X天Y小时Z分」)。例:1303 →「20小时23分」。 */
export function formatGameDuration(gameMinutes: number): string {
  const total = Math.max(0, Math.floor(gameMinutes));
  const days = Math.floor(total / GAME_MINUTES_PER_DAY);
  const hours = Math.floor((total % GAME_MINUTES_PER_DAY) / 60);
  const minutes = total % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}天`);
  }
  if (hours > 0) {
    parts.push(`${hours}小时`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes}分钟`);
  }
  return parts.join('');
}

/**
 * 现实时长(毫秒 → 玩家可读)。例:3.4 小时 / 2.1 天。
 * 只是把数值格式化;游戏↔现实的换算一律走 sim/clock 的常量函数。
 */
export function formatRealDuration(realMs: number): string {
  const minutes = Math.max(0, realMs) / 60_000;
  if (minutes < 1) {
    return '不到1分钟';
  }
  if (minutes < 60) {
    return `${Math.round(minutes)}分钟`;
  }
  const hours = minutes / 60;
  if (hours < 24) {
    return `${hours.toFixed(1)}小时`;
  }
  return `${(hours / 24).toFixed(1)}天`;
}
