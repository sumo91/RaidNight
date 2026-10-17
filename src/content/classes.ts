/**
 * 职业与专精表(数据驱动内容)。
 *
 * 命名遵循 ADR-0002:职业名是通用奇幻词,保留;专精名为原创命名,
 * 结构上与经典 60 年代一一对应。对照表(只存在于开发文档,不进游戏):
 * 铁壁↔防护、破军↔武器、嗜战↔狂怒;守誓↔防护、圣诫↔神圣、惩击↔惩戒;
 * 驭兽↔兽控、神射↔射击、游猎↔生存;毒刃↔奇袭、剑舞↔战斗、影袭↔敏锐;
 * 圣言/祷言↔神圣/戒律、暗影↔暗影;潮汐↔恢复、雷鸣↔元素、熔岩↔增强;
 * 奥术/烈焰/霜寒↔奥法/火法/冰法;苦咒↔痛苦、魔契↔恶魔、焚灭↔毁灭;
 * 兽守↔野性、滋养↔恢复、星辉↔平衡。
 *
 * weight = 生成期的职业分布权重(可调,影响「同一种子生成同一批团员」的抽取)。
 */

/** 职能:团员在活动中的角色分工(坦克 / 治疗 / 输出)。 */
export type Role = '坦克' | '治疗' | '输出';

export interface SpecDef {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
}

export interface ClassDef {
  readonly id: string;
  readonly name: string;
  /** 职业一句话介绍(详情页展示用) */
  readonly description: string;
  /** 生成期职业分布权重 */
  readonly weight: number;
  readonly specs: readonly SpecDef[];
}

export const CLASSES: readonly ClassDef[] = [
  {
    id: 'warrior',
    name: '战士',
    description: '甲胄与怒火并行的近战先锋,团队之盾。',
    weight: 12,
    specs: [
      { id: 'warrior-guard', name: '铁壁', role: '坦克' },
      { id: 'warrior-battle', name: '破军', role: '输出' },
      { id: 'warrior-fury', name: '嗜战', role: '输出' },
    ],
  },
  {
    id: 'paladin',
    name: '圣骑士',
    description: '以誓言为甲的守护者,圣光与战锤兼修。',
    weight: 8,
    specs: [
      { id: 'paladin-oath', name: '守誓', role: '坦克' },
      { id: 'paladin-holy', name: '圣诫', role: '治疗' },
      { id: 'paladin-justicar', name: '惩击', role: '输出' },
    ],
  },
  {
    id: 'hunter',
    name: '猎人',
    description: '与兽为伴的荒野行者,箭无虚发。',
    weight: 10,
    specs: [
      { id: 'hunter-beast', name: '驭兽', role: '输出' },
      { id: 'hunter-marks', name: '神射', role: '输出' },
      { id: 'hunter-wild', name: '游猎', role: '输出' },
    ],
  },
  {
    id: 'rogue',
    name: '盗贼',
    description: '阴影里的短刃,先看到他的人已经倒下。',
    weight: 11,
    specs: [
      { id: 'rogue-venom', name: '毒刃', role: '输出' },
      { id: 'rogue-blade', name: '剑舞', role: '输出' },
      { id: 'rogue-shadow', name: '影袭', role: '输出' },
    ],
  },
  {
    id: 'priest',
    name: '牧师',
    description: '信仰的化身,治愈与暗影一体两面。',
    weight: 10,
    specs: [
      { id: 'priest-light', name: '圣言', role: '治疗' },
      { id: 'priest-prayer', name: '祷言', role: '治疗' },
      { id: 'priest-shadow', name: '暗影', role: '输出' },
    ],
  },
  {
    id: 'shaman',
    name: '萨满祭司',
    description: '与元素立约的智者,图腾立处即阵地。',
    weight: 7,
    specs: [
      { id: 'shaman-tide', name: '潮汐', role: '治疗' },
      { id: 'shaman-storm', name: '雷鸣', role: '输出' },
      { id: 'shaman-lava', name: '熔岩', role: '输出' },
    ],
  },
  {
    id: 'mage',
    name: '法师',
    description: '秩序法则的操纵者,一枚火球一个道理。',
    weight: 12,
    specs: [
      { id: 'mage-arcane', name: '奥术', role: '输出' },
      { id: 'mage-flame', name: '烈焰', role: '输出' },
      { id: 'mage-frost', name: '霜寒', role: '输出' },
    ],
  },
  {
    id: 'warlock',
    name: '术士',
    description: '以灵魂做交易的咒术师,恐惧是他的武器。',
    weight: 8,
    specs: [
      { id: 'warlock-curse', name: '苦咒', role: '输出' },
      { id: 'warlock-pact', name: '魔契', role: '输出' },
      { id: 'warlock-ruin', name: '焚灭', role: '输出' },
    ],
  },
  {
    id: 'druid',
    name: '德鲁伊',
    description: '自然万形的化身,能扛能奶能打。',
    weight: 6,
    specs: [
      { id: 'druid-ward', name: '兽守', role: '坦克' },
      { id: 'druid-renew', name: '滋养', role: '治疗' },
      { id: 'druid-star', name: '星辉', role: '输出' },
    ],
  },
];

/** 按 id 查职业(UI 展示与生成校验共用)。 */
export const CLASS_BY_ID: ReadonlyMap<string, ClassDef> = new Map(
  CLASSES.map((cls) => [cls.id, cls]),
);
