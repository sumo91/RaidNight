/**
 * 性格标签池(数据驱动内容)。
 * 每名团员生成时抽取 1–2 个;v1 中标签主要作为画像与叙事文本,
 * 被动数值影响见后续工单(ADR-0005)。
 */

export interface TraitDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export const TRAIT_POOL: readonly TraitDef[] = [
  { id: 'chill', name: '佛系', description: '输赢随缘,常驻好心情。' },
  { id: 'grinder', name: '肝帝', description: '别人都下线了,他还在。' },
  { id: 'quickhand', name: '手速惊人', description: '关键一瞬从不掉链子。' },
  { id: 'clumsy', name: '手残党', description: '走位全凭一腔热情。' },
  { id: 'lootlover', name: '装备党', description: '装等就是尊严。' },
  { id: 'achiever', name: '成就党', description: '收集癖,缺一不可。' },
  { id: 'social', name: '社交达人', description: '半个服务器都是他熟人。' },
  { id: 'lone', name: '独狼', description: '不抱团,单排之王。' },
  { id: 'chatty', name: '话痨', description: '世界频道刷屏主力。' },
  { id: 'coldwarm', name: '面冷心热', description: '嘴上嫌弃,出药最勤。' },
  { id: 'sharp', name: '毒舌', description: '吐槽精准,从不留情面。' },
  { id: 'peacemaker', name: '老好人', description: '队里起争执,先找他劝。' },
  { id: 'hothead', name: '暴脾气', description: '团灭瞬间血压最高的人。' },
  { id: 'flaky', name: '鸽子王', description: '说好八点开团,九点问几点。' },
  { id: 'stingy', name: '抠门', description: '修理费都要记一笔账。' },
  { id: 'generous', name: '散财童子', description: '合剂药水从来管够。' },
  { id: 'gossiper', name: '包打听', description: '全服八卦的中转站。' },
  { id: 'steadymind', name: '稳如老狗', description: '大风大浪,面不改色。' },
  { id: 'lorenerd', name: '考据党', description: '剧情背景倒背如流。' },
  { id: 'goldminded', name: '分金狂人', description: '打工排班比谁都积极。' },
];

export const TRAIT_BY_ID: ReadonlyMap<string, TraitDef> = new Map(
  TRAIT_POOL.map((trait) => [trait.id, trait]),
);
