/**
 * 出勤画像风格池(数据驱动内容)。
 * 出勤画像 = 风格 + 基础出勤率;实际出勤结算见后续活动工单。
 */

export interface AttendanceStyleDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** 生成期抽取权重 */
  readonly weight: number;
  /** 基础出勤率区间(闭区间,0-100) */
  readonly baseRateRange: readonly [number, number];
}

export const ATTENDANCE_STYLES: readonly AttendanceStyleDef[] = [
  { id: 'iron', name: '铁打的', description: '风雨无阻,全勤楷模。', weight: 6, baseRateRange: [90, 99] },
  { id: 'steady', name: '稳定', description: '按表出勤,极少缺席。', weight: 30, baseRateRange: [75, 92] },
  { id: 'night', name: '夜猫子', description: '白天神隐,晚间战神。', weight: 18, baseRateRange: [55, 80] },
  { id: 'weekend', name: '周末战士', description: '工作日养生,周末爆肝。', weight: 16, baseRateRange: [45, 70] },
  { id: 'spark', name: '三分钟热度', description: '热情来得快,去得也快。', weight: 14, baseRateRange: [35, 65] },
  { id: 'mood', name: '看心情', description: '出勤与否,全看当天。', weight: 16, baseRateRange: [30, 60] },
];

export const ATTENDANCE_BY_ID: ReadonlyMap<string, AttendanceStyleDef> = new Map(
  ATTENDANCE_STYLES.map((style) => [style.id, style]),
);
