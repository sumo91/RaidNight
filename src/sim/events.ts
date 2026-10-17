/**
 * 事件日志:门面输出的日志部分。
 * 每条事件带全局递增序号与发生时刻(游戏分钟),用于回放、断言与 UI 展示。
 */

export type SimEventKind =
  /** 日更:跨越游戏日边界时结算 */
  | '日更'
  /** 周更:跨越游戏周边界时结算(团本 CD 重置等) */
  | '周更'
  /** 公会:会长指令造成的状态变化 */
  | '公会'
  /** 招募:申请池刷新与招入/拒绝/淘汰(申请池见 GLOSSARY) */
  | '招募'
  /** 编成:小队成立/解散与团员调入/调离(编成见 GLOSSARY) */
  | '编成';

export interface SimEvent {
  /** 全局递增序号(从 1 起) */
  readonly seq: number;
  /** 发生时刻:自建会起累计的游戏分钟 */
  readonly atGameMinutes: number;
  readonly kind: SimEventKind;
  readonly text: string;
}
