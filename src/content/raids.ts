/**
 * 团本表与团本结算数值配置(数据驱动内容,T18 全量表)。
 *
 * 规则逻辑在 src/sim/raid.ts(整夜结算)与统一结算引擎 src/sim/encounter.ts;
 * 团队检查门槛在 content/comp.ts(20 人本按规模折半);一切可调数值
 * (首领难度、硬门槛、掉落、套装、G团价目、团灭代价)都在这里,调优不动模拟代码。
 * 命名遵循 ADR-0002:团本名与首领名一律原创,擦边致敬对照表只在开发文档
 * (docs/naming.md),不进游戏。
 * GLOSSARY:团本 = 最高规模的组织性 PvE 活动,按难度分档(tier);
 * 团队 = 最多 8 小队(40 人)的出战阵容;开荒 = 反复挑战尚未通关的内容。
 * 团本 CD = 游戏周(DESIGN):每周边界一个团本夜,按首领顺序逐个结算。
 *
 * T18 全量结构(DESIGN「内容阶梯」):
 * - 4 档 40 人主力团本(tier 1–4),每 tier 出一套 5 件套(2/5 件效果,
 *   DESIGN「装备」):紫装掉落落在套装部位上即带套装 id,同套装穿满 2 件
 *   结算装等 +setBonusItemLevel(结算生效面在 sim/roster.effectiveItemLevel);
 * - 2 个 20 人休闲团本(tier 1/2,casual):门槛低、掉落肥,承担装备追赶;
 *   开放 G团接单(gRunAllowed):以金币结算装备归属(GLOSSARY:G团),
 *   掉落整批卖给买家 —— 金库抽成 + 出战团员均分打工费,是金库的主要进项。
 * 新增团本 = 追加一条数据(档位递增、门槛不越过阶梯),不需要改任何代码。
 */

import type { DropQualityRule, DungeonUnlockGates } from './dungeons';
import type { GearSlot, Quality } from './gear';

/** 团本规模(GLOSSARY:团队最多 8 小队 = 40 人;休闲团本 20 人 = 4 小队)。 */
export type RaidSize = 20 | 40;

/** 团本 tier 套装(DESIGN:每 tier 出 5 件套,2/5 件效果)。 */
export interface TierSetDef {
  readonly id: string;
  /** 套装名(UI 展示与掉落文案)。 */
  readonly name: string;
  /** 套装部位(固定 5 件;该团本的紫装掉落落在这 5 个部位上即为本套)。 */
  readonly slots: readonly GearSlot[];
  /** 2 件起效的套装加成:结算装等加成(硬门槛与战力一并受益,装备追赶的一环)。 */
  readonly setBonusItemLevel: number;
  /** 一句话效果描述(UI 展示)。 */
  readonly effectDescription: string;
}

/** 团本首领定义。 */
export interface RaidBossDef {
  readonly id: string;
  readonly name: string;
  /** 一句话头衔(UI 展示)。 */
  readonly title: string;
  /**
   * 难度目标(战力刻度,与 5 人本同一结算引擎):团队战力与它比较,
   * 低于(目标 − failMargin)必败、高于(目标 + winMargin)必胜、之间线性。
   */
  readonly difficultyTarget: number;
  /**
   * 装等硬门槛:全团平均装等(含套装加成)低于此值 ⇒ 必败(无论战力)。
   * 设置了该字段的首领即「硬门槛首领」—— 装备不达标,打法再好也过不去。
   */
  readonly hardGateItemLevel?: number;
  /** 击杀后掉落的装备件数。 */
  readonly dropsPerKill: number;
  /** 掉落装等基准(品质加成与扰动另计)。 */
  readonly dropItemLevel: number;
}

/** 团本定义(DESIGN:4 档 40 人主力团本 + 2 个 20 人休闲团本)。 */
export interface RaidDef {
  readonly id: string;
  readonly name: string;
  /** 一句话风情描述(UI 展示)。 */
  readonly description: string;
  /** 难度档(1 起;GLOSSARY:按难度分档;休闲团本与同档主力团本同档)。 */
  readonly tier: number;
  /** 规模:40 人主力 / 20 人休闲(团队检查按规模折算,见 sim/comp.ts)。 */
  readonly size: RaidSize;
  /** 休闲团本标记(UI 标签与文案;装备追赶定位)。 */
  readonly casual?: boolean;
  /** 是否开放 G团接单(GLOSSARY:G团 = 以金币结算装备归属的团本形式)。 */
  readonly gRunAllowed?: boolean;
  /** 解锁门槛:公会平均等级 + 公会平均装等(双维,与 5 人本同一判定)。 */
  readonly unlock: DungeonUnlockGates;
  /** 首领表:团本夜按此顺序逐个结算(不许跳级)。 */
  readonly bosses: readonly RaidBossDef[];
  /** 本团本 tier 套装(缺省 = 无套装,休闲团本不出套)。 */
  readonly set?: TierSetDef;
  /** 掉落品质权重(缺省 = RAID_DROP_QUALITY;设套装的团本紫装权重更高)。 */
  readonly dropQuality?: readonly DropQualityRule[];
}

/**
 * 全量团本表:4 档 40 人主力 + 2 个 20 人休闲,共 6 本(T18)。
 * 表内顺序即同档内的服务器阶梯序(serverLadder 按档稳定排序):
 * 熔渊窟(T1)→ 翡林祭坛(T1·20人)→ 烬龙堡垒(T2)→ 晶沙王陵(T2·20人)
 * → 暮晶巨殿(T3)→ 霜寂王座(T4·最终)。
 * 首领难度目标按「标准团队战力 = (平均装等 + 27) × 1.19」粗调:
 * 每档主力团本的硬门槛 ≈ 下一档休闲本解锁装等,装备沿阶梯自洽。
 */
export const RAIDS: readonly RaidDef[] = [
  {
    id: 'molten-abyss',
    name: '熔渊窟',
    description:
      '山根底下熔岩凿出的窟城,元素大军在此操练了千年,就等一个四十人的借口。',
    tier: 1,
    size: 40,
    unlock: { averageLevel: 50, averageItemLevel: 25 },
    set: {
      id: 'molten-heart',
      name: '熔渊之心',
      slots: ['头', '肩', '胸', '腿', '手'],
      setBonusItemLevel: 6,
      effectDescription: '2 件:熔岩贴着甲片流动,结算装等 +6。',
    },
    dropQuality: [
      { quality: '白', weight: 0 },
      { quality: '绿', weight: 15 },
      { quality: '蓝', weight: 45 },
      { quality: '紫', weight: 40 },
    ],
    bosses: [
      {
        id: 'stone-throat-warden',
        name: '石喉守卫',
        title: '窟门处永远醒着的活体石像',
        difficultyTarget: 62,
        dropsPerKill: 8,
        dropItemLevel: 62,
      },
      {
        id: 'searing-chain-hound',
        name: '焚链魔犬',
        title: '烧红的锁链拴了三代驯犬人',
        difficultyTarget: 66,
        dropsPerKill: 8,
        dropItemLevel: 62,
      },
      {
        id: 'ash-archon',
        name: '灰烬执政官',
        title: '硬门槛:没有足够的装等,连它的灰都碰不到',
        difficultyTarget: 70,
        hardGateItemLevel: 36,
        dropsPerKill: 8,
        dropItemLevel: 64,
      },
      {
        id: 'molten-scale-hydra',
        name: '熔鳞多头蛇',
        title: '每一颗头都记仇,而且都喷火',
        difficultyTarget: 72,
        dropsPerKill: 8,
        dropItemLevel: 64,
      },
      {
        id: 'molten-lord-malgar',
        name: '烬渊之主玛尔加恩',
        title: '窟城的心脏,熔渊本身的心思',
        difficultyTarget: 74,
        dropsPerKill: 10,
        dropItemLevel: 66,
      },
    ],
  },
  {
    id: 'jade-shrine',
    name: '翡林祭坛',
    description:
      '雾林深处的青翠祭场,藤蔓编成的神像年年长高一寸,祭品名单也年年加长。',
    tier: 1,
    size: 20,
    casual: true,
    gRunAllowed: true,
    unlock: { averageLevel: 44, averageItemLevel: 15 },
    bosses: [
      {
        id: 'bramble-warden',
        name: '荆祭卫士',
        title: '用整片林子的刺替神像挡刀',
        difficultyTarget: 40,
        dropsPerKill: 10,
        dropItemLevel: 48,
      },
      {
        id: 'bloodplume-priest',
        name: '血羽祭司',
        title: '每根羽毛都蘸过一次献祭',
        difficultyTarget: 46,
        dropsPerKill: 10,
        dropItemLevel: 48,
      },
      {
        id: 'verdant-high-priest',
        name: '苍藤祭王',
        title: '硬门槛:祭王的力量随林中装等一起生长',
        difficultyTarget: 52,
        hardGateItemLevel: 18,
        dropsPerKill: 12,
        dropItemLevel: 50,
      },
    ],
  },
  {
    id: 'ember-bastion',
    name: '烬龙堡垒',
    description:
      '钉在悬崖上的黑铁堡垒,龙焰把每一根梁都烧成了不肯熄的引信。',
    tier: 2,
    size: 40,
    unlock: { averageLevel: 52, averageItemLevel: 44 },
    set: {
      id: 'ember-oath',
      name: '烬龙之誓',
      slots: ['头', '肩', '胸', '腿', '手'],
      setBonusItemLevel: 7,
      effectDescription: '2 件:龙焰在誓约里留下余温,结算装等 +7。',
    },
    dropQuality: [
      { quality: '白', weight: 0 },
      { quality: '绿', weight: 12 },
      { quality: '蓝', weight: 43 },
      { quality: '紫', weight: 45 },
    ],
    bosses: [
      {
        id: 'blackiron-gatekeeper',
        name: '黑铁门神',
        title: '堡垒的第一道门,也是最后一道',
        difficultyTarget: 88,
        dropsPerKill: 8,
        dropItemLevel: 76,
      },
      {
        id: 'drake-guard-captain',
        name: '龙裔禁卫长',
        title: '他带的兵没有活到退伍的',
        difficultyTarget: 92,
        dropsPerKill: 8,
        dropItemLevel: 76,
      },
      {
        id: 'darkflame-whelp',
        name: '暗焰幼龙',
        title: '硬门槛:幼龙的鳞比看上去硬得多',
        difficultyTarget: 96,
        hardGateItemLevel: 48,
        dropsPerKill: 8,
        dropItemLevel: 78,
      },
      {
        id: 'hexborn-golem',
        name: '咒符傀儡',
        title: '满身符文,每一道都是一个死者的名字',
        difficultyTarget: 98,
        dropsPerKill: 8,
        dropItemLevel: 78,
      },
      {
        id: 'ashwing-kharax',
        name: '灰烬之翼卡拉克斯',
        title: '堡垒的主人,烧穿云层的那道影子',
        difficultyTarget: 100,
        dropsPerKill: 10,
        dropItemLevel: 80,
      },
    ],
  },
  {
    id: 'crystal-sand',
    name: '晶沙王陵',
    description:
      '流沙下的琉璃王陵,沙粒在墓道里排成队列,像还在等一声复位的号令。',
    tier: 2,
    size: 20,
    casual: true,
    gRunAllowed: true,
    unlock: { averageLevel: 46, averageItemLevel: 42 },
    bosses: [
      {
        id: 'sandcrystal-sentinel',
        name: '砂晶巡守',
        title: '沙做的身体,玻璃做的心',
        difficultyTarget: 76,
        dropsPerKill: 10,
        dropItemLevel: 62,
      },
      {
        id: 'tomb-weaver',
        name: '陵寝织网蛛',
        title: '它织的网一千年没破,你最好也别破',
        difficultyTarget: 84,
        dropsPerKill: 10,
        dropItemLevel: 62,
      },
      {
        id: 'mausoleum-sovereign',
        name: '陵主砂晶巨虫',
        title: '硬门槛:整座王陵不过是它的一节背甲',
        difficultyTarget: 92,
        hardGateItemLevel: 50,
        dropsPerKill: 12,
        dropItemLevel: 64,
      },
    ],
  },
  {
    id: 'dusk-crystal',
    name: '暮晶巨殿',
    description:
      '黑曜石巨殿没有门窗,进去的人说里面没有黑夜,只有更深的暮色。',
    tier: 3,
    size: 40,
    unlock: { averageLevel: 55, averageItemLevel: 65 },
    set: {
      id: 'dusk-mark',
      name: '暮晶印记',
      slots: ['头', '肩', '胸', '腿', '手'],
      setBonusItemLevel: 8,
      effectDescription: '2 件:暮色顺着印记渗进甲缝,结算装等 +8。',
    },
    dropQuality: [
      { quality: '白', weight: 0 },
      { quality: '绿', weight: 10 },
      { quality: '蓝', weight: 40 },
      { quality: '紫', weight: 50 },
    ],
    bosses: [
      {
        id: 'obsidian-sentinel',
        name: '暮晶哨卫',
        title: '巨殿的第一尊雕像,也是唯一会走的那尊',
        difficultyTarget: 112,
        dropsPerKill: 8,
        dropItemLevel: 86,
      },
      {
        id: 'twin-grimoires',
        name: '双生魔典',
        title: '两本书吵了一千年,吵输了就读你',
        difficultyTarget: 116,
        dropsPerKill: 8,
        dropItemLevel: 86,
      },
      {
        id: 'chaos-observer',
        name: '混沌观测者',
        title: '硬门槛:它看过的一切都会变成它的一部分',
        difficultyTarget: 120,
        hardGateItemLevel: 66,
        dropsPerKill: 8,
        dropItemLevel: 88,
      },
      {
        id: 'void-hunter-nightmaw',
        name: '虚空猎手夜噬',
        title: '它不追猎物,它等猎物自己走进暮色',
        difficultyTarget: 122,
        dropsPerKill: 8,
        dropItemLevel: 88,
      },
      {
        id: 'twilight-archon-zenoras',
        name: '暮光执政官泽诺拉斯',
        title: '巨殿之主,暮色本身为他让路',
        difficultyTarget: 126,
        dropsPerKill: 10,
        dropItemLevel: 90,
      },
    ],
  },
  {
    id: 'frost-throne',
    name: '霜寂王座',
    description:
      '极北冰原下的王座大殿,寒冷不是为了杀人,是为了把一切保存得久一点。',
    tier: 4,
    size: 40,
    unlock: { averageLevel: 58, averageItemLevel: 76 },
    set: {
      id: 'frost-sigil',
      name: '霜寂纹章',
      slots: ['头', '肩', '胸', '腿', '手'],
      setBonusItemLevel: 9,
      effectDescription: '2 件:王座的寒气认得自家纹章,结算装等 +9。',
    },
    dropQuality: [
      { quality: '白', weight: 0 },
      { quality: '绿', weight: 8 },
      { quality: '蓝', weight: 37 },
      { quality: '紫', weight: 55 },
    ],
    bosses: [
      {
        id: 'frostbone-knights',
        name: '霜骸骑士团',
        title: '一整支军队死在了冲锋的号声里',
        difficultyTarget: 120,
        dropsPerKill: 8,
        dropItemLevel: 94,
      },
      {
        id: 'plague-stitcher',
        name: '瘟缝巨匠',
        title: '他的针脚里缝着三场瘟疫',
        difficultyTarget: 124,
        dropsPerKill: 8,
        dropItemLevel: 94,
      },
      {
        id: 'fleshmount-abomination',
        name: '憎恶血肉之山',
        title: '硬门槛:山一样的身体,只能用山一样的装等去撞',
        difficultyTarget: 128,
        hardGateItemLevel: 76,
        dropsPerKill: 8,
        dropItemLevel: 96,
      },
      {
        id: 'bonewing-frostmaw',
        name: '骨翼冰龙凛嚎',
        title: '它的呼吸在地窖里存了一整个纪元',
        difficultyTarget: 130,
        dropsPerKill: 10,
        dropItemLevel: 96,
      },
      {
        id: 'lich-king-varogas',
        name: '巫王瓦罗加斯',
        title: '当期最终首领:王座上的寒寂,一轮弧光的终点',
        difficultyTarget: 130,
        dropsPerKill: 12,
        dropItemLevel: 98,
      },
    ],
  },
];

/** 按 id 查团本(sim 结算与 UI 展示共用)。 */
export const RAID_BY_ID: ReadonlyMap<string, RaidDef> = new Map(
  RAIDS.map((raid) => [raid.id, raid]),
);

/** 当期最终团本(表尾;通关它 = 一轮达成,DESIGN v1 边界:终局 = 通关最终团本)。 */
export const FINAL_RAID: RaidDef = RAIDS[RAIDS.length - 1]!;

/** 团本掉落品质权重(缺省表:不掉白装;设套装的团本在各自条目里抬紫权重)。 */
export const RAID_DROP_QUALITY: readonly DropQualityRule[] = [
  { quality: '白', weight: 0 },
  { quality: '绿', weight: 20 },
  { quality: '蓝', weight: 55 },
  { quality: '紫', weight: 25 },
];

/**
 * G团接单配置(GLOSSARY:G团 = 以金币结算装备归属的团本形式):
 * 20 人休闲团本开放 G团开团 —— 掉落整批卖给随团买家,收入 = 金库抽成
 * + 出战团员均分(打工费,归个人金);结算规则在 sim/raid.ts,价目在此调。
 */
export interface GRRunConfig {
  /** 按品质的整批售价(每件掉落照品质卖出)。 */
  readonly priceByQuality: Readonly<Record<Quality, number>>;
  /** 成交收入入公会金库的比例 %(其余均分给出战的打工团员)。 */
  readonly vaultCutPercent: number;
}

export const G_RUN: GRRunConfig = {
  priceByQuality: { '白': 8, '绿': 45, '蓝': 130, '紫': 320 },
  vaultCutPercent: 30,
};

/** 团本结算可调数值(公式与流程在 sim/raid.ts)。 */
export interface RaidSettlementConfig {
  /** 每次首领战(无论成败)每名团员的疲劳积累。 */
  readonly attemptFatiguePerBoss: number;
  /** 团灭修理金:每名团员(从公会金库扣除,余额不足按余额封顶)。 */
  readonly wipeRepairGoldPerRaider: number;
  /** 团灭额外疲劳(在 attemptFatiguePerBoss 之上)。 */
  readonly wipeFatigue: number;
  /** 团灭士气(心情)打击。 */
  readonly wipeMoodHit: number;
  /** 全通士气(心情)提升。 */
  readonly clearMoodBoost: number;
  /** 掉落装等扰动幅度(±)。 */
  readonly dropJitter: number;
  /** 击杀首领时最多倒下的团人数(演出用:险胜倒得多,碾压倒得少)。 */
  readonly killFallenCap: number;
}

export const RAID_SETTLEMENT: RaidSettlementConfig = {
  attemptFatiguePerBoss: 8,
  wipeRepairGoldPerRaider: 3,
  wipeFatigue: 12,
  wipeMoodHit: 10,
  clearMoodBoost: 8,
  dropJitter: 1,
  killFallenCap: 6,
};
