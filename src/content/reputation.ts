/**
 * 声望配置(数据驱动内容,T12):7 档 × 3 星声望系统 + 荣誉墙 + 自动退会 + 名人堂。
 *
 * GLOSSARY:声望等级 = 公会在虚拟服务器中的名望刻度,影响招募池质量等;
 * 荣誉墙 = 首杀、成就与收藏的陈列界面;名人堂 = 陈列历代团员(含已离会者)
 * 去向与功绩的板块;首杀 = 全服或本公会首次击杀某团本首领的荣誉记录
 * (虚拟服务器与竞争公会属后续工单,本票首杀 = 本会首次击杀)。
 * 规则逻辑在 src/sim/reputation.ts 与门面的日界结算;一切可调数值与文案
 * 都在这里,调优不动模拟代码。命名遵循 ADR-0002(原创,不用既有 IP 专名)。
 */

/** 声望档位定义:7 档,每档 3 星(档内升星);档位驱动名册上限与挖版权限。 */
export interface ReputationTierDef {
  readonly id: string;
  /** 档位名(UI 展示;GLOSSARY:声望等级)。 */
  readonly name: string;
  /** 一句话风情(UI 展示)。 */
  readonly blurb: string;
  /**
   * 档内升到 1★/2★/3★ 所需的声望值(档内累计:基准 + starPoints[0..2];
   * 下一档从本档 3★ 值起算,跨档累计由 sim/reputation.ts 推导)。
   */
  readonly starPoints: readonly [number, number, number];
  /** 达到本档后的名册上限加成(在 baseRosterCap 之上;GLOSSARY:名册上限随声望成长)。 */
  readonly rosterCapBonus: number;
  /** 达到本档起解锁挖角(GLOSSARY:挖角 = 从背景公会招揽在册成员;系统在后续工单)。 */
  readonly poachUnlocked: boolean;
}

/**
 * 声望档位表:7 档,阶位(rung)= 档序 × 3 + 星,共 21 级。
 * 档位分值与名册上限按「一轮 6–8 游戏周」粗调(T18):名册上限的成长
 * 要跟得上内容阶梯 —— 20 人休闲团本(21 人)在第 3 档放开,40 人主力
 * 团本(40 人编满 + 冷板凳余量)在第 6 档放开,传奇档留出替补席余量。
 */
export const RENOWN_TIERS: readonly ReputationTierDef[] = [
  {
    id: 'unknown',
    name: '无名小会',
    blurb: '刚挂出会徽,还没人知道门朝哪边开。',
    starPoints: [4, 7, 10],
    rosterCapBonus: 0,
    poachUnlocked: false,
  },
  {
    id: 'rising',
    name: '初露头角',
    blurb: '练级路上开始有人打听这个会。',
    starPoints: [6, 8, 10],
    rosterCapBonus: 4,
    poachUnlocked: false,
  },
  {
    id: 'known',
    name: '闻名一方',
    blurb: '主城招募频道里有了你们的名字。',
    starPoints: [10, 12, 14],
    rosterCapBonus: 10,
    poachUnlocked: true,
  },
  {
    id: 'contender',
    name: '服务器劲旅',
    blurb: '全服开始正视你们的进度。',
    starPoints: [14, 16, 18],
    rosterCapBonus: 16,
    poachUnlocked: true,
  },
  {
    id: 'rival',
    name: '争锋公会',
    blurb: '首杀榜上,你们和别人掰起了手腕。',
    starPoints: [17, 19, 21],
    rosterCapBonus: 24,
    poachUnlocked: true,
  },
  {
    id: 'renowned',
    name: '名门公会',
    blurb: '新人挤破头想递申请。',
    starPoints: [20, 22, 24],
    rosterCapBonus: 34,
    poachUnlocked: true,
  },
  {
    id: 'legend',
    name: '服务器传奇',
    blurb: '后来者会讲起这个会的传说。',
    starPoints: [23, 25, 27],
    rosterCapBonus: 44,
    poachUnlocked: true,
  },
];

/** 声望阶位总数 = 档数 × 3(21;0 阶 = 建会起步)。 */
export const RENOWN_RUNG_COUNT = RENOWN_TIERS.length * 3;

/** 里程碑类别:条件求值方式(规则在 sim/reputation.ts;阈值与分值在此)。 */
export type MilestoneKind =
  /** 公会平均等级达到 threshold */
  | 'avgLevel'
  /** 在册团员数(含会长角色)达到 threshold */
  | 'rosterSize'
  /** 名册中出现等级封顶的团员 */
  | 'maxLevelMember'
  /** 本日有 5 人本速通(信号触发,一次性) */
  | 'firstDungeonClear'
  /** 本夜有团本全通(信号触发,一次性) */
  | 'firstRaidClear'
  /** 本日有紫装被人穿上(信号触发,一次性) */
  | 'firstPurpleEquipped'
  /** 金库历史收入累计达到 threshold */
  | 'vaultIncome';

/** 里程碑定义:荣誉墙「里程碑」陈列 + 声望加分来源。 */
export interface MilestoneDef {
  readonly id: string;
  readonly name: string;
  /** 达成条件的一句话描述(UI 展示与事件文案)。 */
  readonly description: string;
  readonly kind: MilestoneKind;
  /** avgLevel / rosterSize / vaultIncome 的门槛值。 */
  readonly threshold?: number;
  /** 达成时的声望加分。 */
  readonly points: number;
}

/** 里程碑表(荣誉墙按达成时刻陈列;同一里程碑只达成一次)。 */
export const MILESTONES: readonly MilestoneDef[] = [
  { id: 'avg-level-20', name: '初具规模', description: '公会平均等级达到 20 级', kind: 'avgLevel', threshold: 20, points: 8 },
  { id: 'avg-level-40', name: '练级路上', description: '公会平均等级达到 40 级', kind: 'avgLevel', threshold: 40, points: 8 },
  { id: 'avg-level-55', name: '满编远征', description: '公会平均等级达到 55 级', kind: 'avgLevel', threshold: 55, points: 12 },
  { id: 'roster-10', name: '十人之会', description: '在册团员达到 10 人', kind: 'rosterSize', threshold: 10, points: 8 },
  { id: 'roster-20', name: '二十人之会', description: '在册团员达到 20 人', kind: 'rosterSize', threshold: 20, points: 10 },
  { id: 'roster-30', name: '三十人之会', description: '在册团员达到 30 人', kind: 'rosterSize', threshold: 30, points: 12 },
  { id: 'roster-40', name: '四十人满编', description: '在册团员达到 40 人(整编团队)', kind: 'rosterSize', threshold: 40, points: 15 },
  { id: 'first-max-level', name: '第一位满级', description: '名册中出现第一位满级团员', kind: 'maxLevelMember', points: 10 },
  { id: 'first-dungeon-clear', name: '开荒开门红', description: '首次打通一座 5 人本', kind: 'firstDungeonClear', points: 10 },
  { id: 'first-raid-clear', name: '首通团本', description: '首个团本夜全通', kind: 'firstRaidClear', points: 30 },
  { id: 'first-purple', name: '首件紫装', description: '第一件紫装穿上了团员的身', kind: 'firstPurpleEquipped', points: 6 },
  { id: 'vault-income-1000', name: '金库盈千', description: '公会金库历史收入累计达 1000 金', kind: 'vaultIncome', threshold: 1000, points: 8 },
];

/** 声望来源分值。 */
export const RENOWN_SOURCES = {
  /**
   * 首杀加分:按团本难度档(1 起)取本会首杀一名首领的声望
   * (下标 = 档位 − 1;超出表尾的更高档按末档)。
   */
  firstKillPointsByRaidTier: [10, 14, 18, 22] as const,
};

/** 自动退会条件(GLOSSARY:忠诚过低或长期冷板凳自动退会;会长角色除外)。 */
export const RESIGNATION = {
  /** 忠诚 ≤ 该值的团员在日界自动退会(会长角色除外)。 */
  loyaltyThreshold: 15,
  /**
   * 连续未编入任何小队的游戏日数达到该值即自动退会(会长角色除外)。
   * 计数前提:公会至少已有一支小队(尚无编成概念的新会不计数)。
   */
  benchDaysThreshold: 7,
} as const;

/** 离会方式(名人堂陈列与事件文案共用)。 */
export type DepartureReason = '会长淘汰' | '忠诚不足' | '长期冷板凳';

/** 离会台词池(数据驱动;按团员 id 确定性地取用,不消费随机链)。 */
export const FAREWELL_LINES: Readonly<Record<DepartureReason, readonly string[]>> = {
  会长淘汰: ['此处不留人,自有留人处。', '行,是我技不如人。', '背包收好,后会无期。'],
  忠诚不足: [
    '工资可以再谈,寒心没法装作没看见。',
    '我信过这个会,可惜这个会没信过我们。',
    '散了吧,装备我自己再打一套就是。',
    '有些会值得熬,有些不值得。我分得清。',
    '祝你们打得顺利。我先走一步。',
  ],
  长期冷板凳: [
    '板凳都坐出包浆了,我去别处找场子。',
    '我的时代还没开始就结束了?换个会再开。',
    '练级我一个人也能练,但我不想一个人练。',
    '会长,队里没我的位置,天下有的是。',
    '看看别人的会怎么排阵吧,告辞。',
  ],
};

/** 去向池(名人堂「去向」陈列;按团员 id 确定性地取用)。 */
export const DESTINATION_POOLS: readonly string[] = [
  '加入了背景公会「霜语会」',
  '加入了背景公会「灰烬兄弟会」',
  '跟一支野团去了更暖的南方',
  '回乡接手了家里的果园',
  '在主城桥头支起了烤肉摊',
  '给竞争公会当起了陪练',
  '据说去了海对面的新大陆',
  '成了酒馆里讲故事的人',
];
