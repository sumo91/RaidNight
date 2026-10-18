/**
 * 周计划内容表(计划层,T15,DESIGN「管理三层」)。
 *
 * 当周目标的三种取向与其数值钩子:目标是常驻周计划的属性,自动层照计划
 * 每周开团时把钩子带进团本夜结算(规则在 sim/raid.ts 与 sim/facade.ts)。
 * 一切可调数值在此,调优不动模拟代码;新增目标 = 追加一条数据。
 *
 * 三种取向的设计意图(与三柱对应):
 * - 推进(裁量之乐·开荒):全力向上推,团灭也是进度 —— 并肩开荒凝聚人心;
 * - farm(经济循环):回头刷熟本 —— 无人可提升的掉落卖店换金库收入;
 * - 带新(组建之乐·主柱,ADR-0006):装备往新人身上带 —— 装等最低者优先。
 */

/** 当周目标 id(GLOSSARY:计划层 —— 会长定期设定目标与开团安排)。 */
export type WeeklyGoalId = 'progress' | 'farm' | 'mentor';

/** 掉落分配倾斜(带新专属):影响会长裁量制的「合理分配」择优规则;制度(DKP/GKP)不倾斜。 */
export type WeeklyLootTilt = 'none' | 'lowestItemLevel';

/** 当周目标定义。 */
export interface WeeklyGoalDef {
  readonly id: WeeklyGoalId;
  readonly name: string;
  /** 一句话取向(决策选项标注)。 */
  readonly tagline: string;
  /** 长文案(UI 说明)。 */
  readonly description: string;
  /** 团本夜末出席团员的心情调整(在制度心态之上叠加;钳制 0-100)。 */
  readonly attendeeMoodPerNight: number;
  /** 团本夜末出席团员的忠诚调整(会长角色除外;钳制 0-100)。 */
  readonly attendeeLoyaltyPerNight: number;
  /** 无人可提升的团本掉落卖店所得/件(0 = 照旧分解不给钱;收入进公会金库)。 */
  readonly salvageGoldPerDrop: number;
  /** 会长裁量制下的分配倾斜。 */
  readonly lootTilt: WeeklyLootTilt;
}

export const WEEKLY_GOALS: readonly WeeklyGoalDef[] = [
  {
    id: 'progress',
    name: '推进',
    tagline: '开荒向上推,团灭也是进度',
    description: '全力挑战首领阶梯。并肩开荒凝聚人心:出席者忠诚与心情小幅上涨。',
    attendeeMoodPerNight: 2,
    attendeeLoyaltyPerNight: 2,
    salvageGoldPerDrop: 0,
    lootTilt: 'none',
  },
  {
    id: 'farm',
    name: 'farm',
    tagline: '回头刷熟本,装备换金',
    description: '重复挑战熟悉的团本:无人可提升的掉落自动卖店,收入进公会金库。',
    attendeeMoodPerNight: 1,
    attendeeLoyaltyPerNight: 0,
    salvageGoldPerDrop: 8,
    lootTilt: 'none',
  },
  {
    id: 'mentor',
    name: '带新',
    tagline: '装备往新人身上带',
    description: '带新人成长:会长裁量制下,可提升的掉落优先分给全团装等最低的出席者。',
    attendeeMoodPerNight: 1,
    attendeeLoyaltyPerNight: 1,
    salvageGoldPerDrop: 0,
    lootTilt: 'lowestItemLevel',
  },
];

/** 按 id 查目标(sim 结算与 UI 展示共用)。 */
export const WEEKLY_GOAL_BY_ID: ReadonlyMap<WeeklyGoalId, WeeklyGoalDef> = new Map(
  WEEKLY_GOALS.map((goal) => [goal.id, goal]),
);

/** 新设计划的缺省目标(UI 首次设定时的预选;规则上无强制)。 */
export const DEFAULT_WEEKLY_GOAL: WeeklyGoalId = 'progress';
