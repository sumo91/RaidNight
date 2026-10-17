/**
 * 编成配置与小队光环表(数据驱动内容)。
 *
 * 规则逻辑在 src/sim/comp.ts;一切可调数值(小队规模、职能结构、团队检查
 * 门槛、光环加成)都在这里,调优不动模拟代码。
 * 光环命名遵循 ADR-0002:通用奇幻词,不使用既有 IP 专名,且不与专精名撞车。
 */

/** 光环加成类别:编成页预览用;结算时映射到活动结算(后续工单)。 */
export type AuraStat = '伤害' | '生存' | '治疗';

/** 小队光环定义(GLOSSARY:特定职业在小队内为全队提供的被动加成)。 */
export interface AuraDef {
  readonly id: string;
  /** 提供该光环的职业(classId 对应 content/classes.CLASSES) */
  readonly classId: string;
  readonly name: string;
  readonly description: string;
  readonly stat: AuraStat;
  /** 加成百分比(整数);同职业光环不叠加,不同职业加成相加 */
  readonly percent: number;
}

export interface CompConfig {
  /** 小队人数上限(GLOSSARY:5 人制的基本编组单位)。 */
  readonly squadSize: number;
  /** 团队的小队数上限(GLOSSARY:团队最多 8 小队 = 40 人)。 */
  readonly maxSquads: number;
  /** 小队职能结构:至少几坦克/几治疗(编成页据此实时标示缺口)。 */
  readonly squadStructure: {
    readonly minTanks: number;
    readonly minHealers: number;
  };
  /** 团队检查(DESIGN:总坦克数、总治疗数、职能覆盖)。 */
  readonly teamCheck: {
    /** 成团需要的满员小队数(40 人团队 = 8 支)。 */
    readonly requiredFullSquads: number;
    /** 全团队总坦克数下限。 */
    readonly minTanks: number;
    /** 全团队总治疗数下限。 */
    readonly minHealers: number;
  };
}

export const COMP: CompConfig = {
  squadSize: 5,
  maxSquads: 8,
  squadStructure: { minTanks: 1, minHealers: 1 },
  teamCheck: { requiredFullSquads: 8, minTanks: 4, minHealers: 8 },
};

/** 9 职业各一个小队光环;编队即职业组合的拼图(GLOSSARY:小队光环)。 */
export const AURAS: readonly AuraDef[] = [
  {
    id: 'battle-shout',
    classId: 'warrior',
    name: '战吼',
    description: '战斗的呐喊激起全队的血性。',
    stat: '伤害',
    percent: 6,
  },
  {
    id: 'devotion-aura',
    classId: 'paladin',
    name: '虔诚光环',
    description: '祝圣过的护盾光辉笼罩小队。',
    stat: '生存',
    percent: 8,
  },
  {
    id: 'hunt-rhythm',
    classId: 'hunter',
    name: '狩猎节奏',
    description: '猎人的呼吸与箭息稳住全队的手。',
    stat: '伤害',
    percent: 5,
  },
  {
    id: 'weakness-insight',
    classId: 'rogue',
    name: '弱点洞察',
    description: '盗贼指出的破绽,人人都能补上一刀。',
    stat: '伤害',
    percent: 4,
  },
  {
    id: 'soothing-hymn',
    classId: 'priest',
    name: '抚慰颂歌',
    description: '低声的祷词抚慰全队的伤口。',
    stat: '治疗',
    percent: 8,
  },
  {
    id: 'spring-totem',
    classId: 'shaman',
    name: '涌泉图腾',
    description: '立起的图腾涌出治愈的清泉。',
    stat: '治疗',
    percent: 6,
  },
  {
    id: 'arcane-resonance',
    classId: 'mage',
    name: '奥能共鸣',
    description: '法师的秘法场域放大全队的杀伤。',
    stat: '伤害',
    percent: 5,
  },
  {
    id: 'blood-pact',
    classId: 'warlock',
    name: '血契',
    description: '术士以血立契,全队筋骨为之强韧。',
    stat: '生存',
    percent: 6,
  },
  {
    id: 'wild-blessing',
    classId: 'druid',
    name: '野性赐福',
    description: '自然的祝福覆上全队的肩头。',
    stat: '生存',
    percent: 5,
  },
];

/** 按职业 id 查光环(sim 计算与 UI 展示共用)。 */
export const AURA_BY_CLASS: ReadonlyMap<string, AuraDef> = new Map(
  AURAS.map((aura) => [aura.classId, aura]),
);
