import { WEEKDAY_NAMES, dayOfWeek, gameWeek, minuteOfDay } from '../sim/clock';

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
