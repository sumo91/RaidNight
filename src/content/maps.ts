/**
 * 练级地图表与练级数值配置(数据驱动内容)。
 *
 * 规则逻辑在 src/sim/leveling.ts;一切可调数值(地图收益/损耗、等级带、
 * 经验曲线、休整速度)都在这里,调优不动模拟代码。
 * 命名遵循 ADR-0002:地名全部原创,擦边致敬对照表只在开发文档
 * (docs/naming.md),不进游戏。
 * 两档风险(GLOSSARY:高效区/休闲区)成对解锁:同阶段两档同时开放,
 * 高效区经验多、疲劳与阵亡损耗高,休闲区反之 —— 梯子往上走时
 * 「上一阶段的高效区 ≈ 下一阶段的休闲区」,风险取舍始终成立。
 * 等级带(GLOSSARY:内容阶梯)在 1..maxLevel 上首尾相接、不重叠、不跳段:
 * 带下限 = 解锁门槛(公会平均等级),带上限 = 适宜等级的终点(下一阶段的起点-1)。
 * 新增地图 = 追加一条数据并保持带的连续(结构校验见 sim/ladder.ts)。
 */

/** 练级地图的风险档:高效区 / 休闲区(GLOSSARY)。 */
export type LevelingRiskTier = '高效' | '休闲';

/** 等级带:地图适宜的等级范围;下限 = 解锁门槛(公会平均等级)。 */
export interface LevelBand {
  readonly min: number;
  readonly max: number;
}

/** 练级地图定义。 */
export interface LevelingMapDef {
  readonly id: string;
  readonly name: string;
  /** 一句话风情描述(UI 展示)。 */
  readonly description: string;
  readonly tier: LevelingRiskTier;
  /** 等级带:本阶段覆盖的等级区间(各阶段首尾相接,见文件头说明)。 */
  readonly levelBand: LevelBand;
  /** 每游戏日每人经验收益(疲劳修正前)。 */
  readonly xpPerDay: number;
  /** 每游戏日每人疲劳积累。 */
  readonly fatiguePerDay: number;
  /** 每游戏日每人阵亡概率(0-1)。 */
  readonly deathChancePerDay: number;
}

/**
 * 练级地图:5 个阶段 × 2 档风险,共 10 张(DESIGN 全量 10–12 张的下沿;
 * 后续工单在保持等级带连续的前提下扩表)。
 * 按等级带下限升序排列;同阶段两张同带同解锁。
 */
export const LEVELING_MAPS: readonly LevelingMapDef[] = [
  {
    id: 'windmill-plains',
    name: '风磨草原',
    description: '缓丘上的风车小镇,野兽温顺,边喝麦酒边磨刀。',
    tier: '休闲',
    levelBand: { min: 1, max: 13 },
    xpPerDay: 900,
    fatiguePerDay: 5,
    deathChancePerDay: 0.03,
  },
  {
    id: 'quarry-camp',
    name: '采石场营地',
    description: '矿脉深处怪物密集,经验丰厚;塌方与围殴也随时发生。',
    tier: '高效',
    levelBand: { min: 1, max: 13 },
    xpPerDay: 3000,
    fatiguePerDay: 16,
    deathChancePerDay: 0.22,
  },
  {
    id: 'mistmarsh',
    name: '雾沼',
    description: '沼泽的雾气让人放慢脚步,毒虫不算凶狠,收获细水长流。',
    tier: '休闲',
    levelBand: { min: 14, max: 25 },
    xpPerDay: 3000,
    fatiguePerDay: 6,
    deathChancePerDay: 0.04,
  },
  {
    id: 'blackpine-hollow',
    name: '黑松林穴',
    description: '黑松林下的地穴怪堆密布,凶险与经验成正比。',
    tier: '高效',
    levelBand: { min: 14, max: 25 },
    xpPerDay: 8000,
    fatiguePerDay: 17,
    deathChancePerDay: 0.23,
  },
  {
    id: 'frostwind-pass',
    name: '霜风隘口',
    description: '隘口的风雪磨人筋骨,也磨出扎实的功底。',
    tier: '休闲',
    levelBand: { min: 26, max: 37 },
    xpPerDay: 8000,
    fatiguePerDay: 7,
    deathChancePerDay: 0.04,
  },
  {
    id: 'cinder-mine',
    name: '灰烬矿道',
    description: '废矿深处的元素躁动不安,回报惊人,损耗也惊人。',
    tier: '高效',
    levelBand: { min: 26, max: 37 },
    xpPerDay: 20000,
    fatiguePerDay: 18,
    deathChancePerDay: 0.24,
  },
  {
    id: 'windworn-hills',
    name: '风蚀残丘',
    description: '焦土上的残丘被风磨了千年,老猎人说慢走慢打总有收获。',
    tier: '休闲',
    levelBand: { min: 38, max: 49 },
    xpPerDay: 20000,
    fatiguePerDay: 8,
    deathChancePerDay: 0.05,
  },
  {
    id: 'slag-ravine',
    name: '熔渣峡谷',
    description: '谷底的熔渣还没凉透,元素生物成群结队,金砂与灰烬齐飞。',
    tier: '高效',
    levelBand: { min: 38, max: 49 },
    xpPerDay: 48000,
    fatiguePerDay: 19,
    deathChancePerDay: 0.25,
  },
  {
    id: 'duskpine-sea',
    name: '暮松林海',
    description: '暮色里的一望无际的松涛,毒雾不重,猎物却足够老练。',
    tier: '休闲',
    levelBand: { min: 50, max: 60 },
    xpPerDay: 48000,
    fatiguePerDay: 9,
    deathChancePerDay: 0.05,
  },
  {
    id: 'emberdrake-waste',
    name: '烬龙荒原',
    description: '黑翼掠过的荒原上什么都会烧起来,包括你的补给和运气。',
    tier: '高效',
    levelBand: { min: 50, max: 60 },
    xpPerDay: 120000,
    fatiguePerDay: 20,
    deathChancePerDay: 0.26,
  },
];

/** 按 id 查地图(sim 结算与 UI 展示共用)。 */
export const LEVELING_MAP_BY_ID: ReadonlyMap<string, LevelingMapDef> = new Map(
  LEVELING_MAPS.map((map) => [map.id, map]),
);

/** 练级规则的可调数值(公式本身在 sim/leveling.ts)。 */
export interface LevelingConfig {
  /** 等级上限(60 时代结构)。 */
  readonly maxLevel: number;
  /** 疲劳上限(三维状态刻度)。 */
  readonly maxFatigue: number;
  /** 升级经验曲线:升级所需经验 = perLevel×等级 + perLevelSquared×等级²。 */
  readonly xpCurve: {
    readonly perLevel: number;
    readonly perLevelSquared: number;
  };
  /** 休整:每游戏日恢复的疲劳(未安排练级的团员)。 */
  readonly restFatiguePerDay: number;
  /** 每点疲劳降低的经验效率(0.005 = 疲劳 100 时效率降一半)。 */
  readonly efficiencyLossPerFatigue: number;
  /** 经验效率下限(疲劳再高也保底)。 */
  readonly minEfficiency: number;
  /** 阵亡损耗:当日经验损失比例与额外疲劳。 */
  readonly death: {
    readonly xpLossPercent: number;
    readonly fatiguePenalty: number;
  };
}

export const LEVELING: LevelingConfig = {
  maxLevel: 60,
  maxFatigue: 100,
  xpCurve: { perLevel: 60, perLevelSquared: 8 },
  restFatiguePerDay: 15,
  efficiencyLossPerFatigue: 0.005,
  minEfficiency: 0.5,
  death: { xpLossPercent: 25, fatiguePenalty: 6 },
};
