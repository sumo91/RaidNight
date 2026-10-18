/**
 * 虚拟服务器配置(数据驱动内容,T13):服务器、NPC 公会群与全服新闻。
 *
 * GLOSSARY:虚拟服务器 = 玩家公会所在的模拟服务器生态,含上百个 NPC 公会
 * 与全服公告;竞争公会 = 少数有成长曲线的高层 NPC 公会,受橡皮筋规则约束
 * (可被超越、不恶性行为);背景公会 = 大量不成长或极缓成长的 NPC 公会,
 * 用于营造服务器的规模感;橡皮筋 = 竞争公会进度以玩家进度为锚:玩家正常
 * 推进时对方慢半拍,长期停滞时对方才超车并发全服新闻 —— 不锁内容、
 * 不拿走本会首杀(荣誉墙的本会首杀徽章永远属于玩家自己的击杀)。
 * 规则逻辑在 src/sim/world.ts 与门面的日/周边界结算;一切可调数值与文案池
 * 都在这里,调优不动模拟代码。命名遵循 ADR-0002(原创,不用既有 IP 专名,
 * 对照登记见 docs/naming.md)。
 */

/** 竞争公会定义(GLOSSARY:少数有成长曲线的高层 NPC 公会)。 */
export interface RivalGuildDef {
  readonly id: string;
  /** 公会名(UI 展示与新闻署名)。 */
  readonly name: string;
  /** 一句话行事风格(UI「竞争公会」卡展示)。 */
  readonly style: string;
  /**
   * 档内底蕴分:团本击杀分之外的排名底蕴(老牌会的家底)。
   * 排名分 = 每首领击杀分 × 阶梯推进数 + 底蕴分。
   */
  readonly restScore: number;
}

/** 竞争公会表:6 支有成长曲线的高层 NPC 公会(受橡皮筋约束)。 */
export const RIVAL_GUILDS: readonly RivalGuildDef[] = [
  {
    id: 'star-crown',
    name: '星冠议会',
    style: '老牌元老会,家底深厚,开荒稳得像钟表。',
    restScore: 88,
  },
  {
    id: 'iron-tide',
    name: '铁潮军团',
    style: '军事化管理,进度就是军令,团长说话像打拍子。',
    restScore: 82,
  },
  {
    id: 'night-song',
    name: '夜歌秘社',
    style: '昼伏夜出的神秘会,专挑没人守的首领下手。',
    restScore: 76,
  },
  {
    id: 'crag-maul',
    name: '蛮岩战团',
    style: '一鼓作气,再而衰,三而团灭也不散伙。',
    restScore: 70,
  },
  {
    id: 'azure-blade',
    name: '苍蓝之刃',
    style: '金团新贵,烧钱抢人毫不手软。',
    restScore: 64,
  },
  {
    id: 'dawn-march',
    name: '破晓远征',
    style: '半工半打的远征军,人人都有白班要上。',
    restScore: 58,
  },
];

/** 按公会名查竞争公会定义(UI 竞争公会卡共用;名字在服务器内唯一)。 */
export const RIVAL_GUILD_BY_NAME: ReadonlyMap<string, RivalGuildDef> = new Map(
  RIVAL_GUILDS.map((def) => [def.name, def]),
);

/** 背景公会名池:前缀 × 后缀组合,生成期去重(GLOSSARY:背景公会)。 */
export const GUILD_NAME_PREFIXES: readonly string[] = [
  '霜语',
  '灰烬',
  '铁炉',
  '苍穹',
  '烈风',
  '磐石',
  '黑铁',
  '白鸦',
  '赤岭',
  '狼群',
  '山巅',
  '浪涛',
  '荆棘',
  '星陨',
  '迷雾',
  '寒鸦',
  '金穗',
  '孤狼',
  '雷鸣',
  '岩皮',
  '夜幕',
  '翠湖',
  '荒火',
  '冻土',
  '熊吼',
  '蜂鸟',
  '獠牙',
  '古树',
  '雪线',
  '风信',
  '烛火',
  '龙脊',
  '盐滩',
  '回声',
  '雾岩',
  '暮色',
];

export const GUILD_NAME_SUFFIXES: readonly string[] = [
  '会',
  '兄弟会',
  '战团',
  '议会',
  '同盟',
  '商会',
  '骑士团',
  '旅团',
  '先锋',
  '猎团',
  '秘社',
  '之翼',
];

/** 抢苗子新闻文案池:{guild} = 出手公会,{name} = 被截胡的苗子。 */
export const POACH_NEWS_POOL: readonly string[] = [
  '「{guild}」出手截胡:苗子「{name}」被双倍签约金签走,今日申请池少了一份。',
  '「{guild}」的招募官堵在了「{name}」家门口 —— 这份申请被撤回了。',
  '听说「{guild}」给「{name}」开出了让人无法拒绝的价码 —— 今日申请池被截走一份。',
];

/** 虚拟服务器可调数值(公式与流程在 sim/world.ts 与门面结算)。 */
export interface WorldConfig {
  /** 服务器名(新闻与世界页标题)。 */
  readonly serverName: string;
  /** 背景公会的生成数量(加竞争公会 6 支 = NPC 公会总数,须上百)。 */
  readonly backgroundGuildCount: number;
  /** 排名分刻度。 */
  readonly ladder: {
    /** 每击杀一名团本首领的进度分(一杀压过全部成长分)。 */
    readonly scorePerBoss: number;
    /** 玩家成长分 = 平均等级 × playerLevelWeight + 平均装等 × playerItemLevelWeight。 */
    readonly playerLevelWeight: number;
    readonly playerItemLevelWeight: number;
    /** 玩家成长分上限(封顶不足一杀:团本击杀才是排名主旋律)。 */
    readonly playerGrowthCap: number;
  };
  /** 橡皮筋(GLOSSARY):竞争公会进度以玩家进度为锚的调节。 */
  readonly rubberBand: {
    /** 正常推进时,竞争公会最多推进到「玩家进度 − lagBosses」(慢半拍)。 */
    readonly lagBosses: number;
    /** 锚拉紧时,每个周边界最多推进的首领数。 */
    readonly weeklyAdvance: number;
    /** 玩家连续停滞达到该周数,竞争公会转入追赶。 */
    readonly stallWeeksToCatchUp: number;
    /** 追赶期每个周边界推进的首领数(超车之势;封顶 = 阶梯全长)。 */
    readonly catchUpWeeklyAdvance: number;
  };
  /** 背景公会的规模感参数(GLOSSARY:不成长或极缓成长)。 */
  readonly background: {
    /** 基础分生成区间。 */
    readonly baseScoreRange: readonly [number, number];
    /** 极缓成长档位:每 N 周分数 +1;池中重复越多越常见,0 = 完全静止。 */
    readonly driftWeeksChoices: readonly number[];
    /** 极缓成长上限(背景公会永不挤进团本档)。 */
    readonly driftCeiling: number;
  };
  /** 抬价波:竞争公会扫货 → 团灭修理金上浮(轻量可感知,到期回落)。 */
  readonly market: {
    /** 每隔多少个游戏日掀起一波(相位由建会种子定,存档间有差异)。 */
    readonly periodDays: number;
    /** 一波持续的遊戏日数。 */
    readonly durationDays: number;
    /** 团灭修理金上浮百分比。 */
    readonly repairMarkupPercent: number;
  };
  /** 抢苗子:竞争公会从申请池截走最好的一份申请(GLOSSARY:申请池)。 */
  readonly poach: {
    /** 每隔多少个游戏日出手一次(相位由建会种子定)。 */
    readonly periodDays: number;
    /** 截胡后申请池至少保留的份数(绝不截空)。 */
    readonly minPoolLeft: number;
  };
  /** 全服新闻流的保留条数(超出的旧闻裁掉,存档体量有界)。 */
  readonly newsKeepCount: number;
  /** 排名新闻阈值:玩家首次杀入该名次段(含)以内时发全服新闻。 */
  readonly rankNewsThresholds: readonly number[];
}

export const WORLD: WorldConfig = {
  serverName: '晨风服务器',
  backgroundGuildCount: 102,
  ladder: {
    scorePerBoss: 100,
    playerLevelWeight: 1.5,
    playerItemLevelWeight: 0.75,
    playerGrowthCap: 99,
  },
  rubberBand: {
    lagBosses: 1,
    weeklyAdvance: 1,
    stallWeeksToCatchUp: 2,
    catchUpWeeklyAdvance: 2,
  },
  background: {
    baseScoreRange: [6, 92],
    driftWeeksChoices: [0, 0, 0, 0, 10, 14, 20],
    driftCeiling: 96,
  },
  market: {
    periodDays: 12,
    durationDays: 5,
    repairMarkupPercent: 15,
  },
  poach: {
    periodDays: 5,
    minPoolLeft: 1,
  },
  newsKeepCount: 80,
  rankNewsThresholds: [50, 20, 10, 5, 3, 2, 1],
};
