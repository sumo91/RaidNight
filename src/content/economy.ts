/**
 * 经济配置(数据驱动内容):双钱包、外快活动与分配制度。
 *
 * GLOSSARY:个人金 = 团员私有的金币(打工与野团所得归此);
 * 公会金库 = 公会公共资金;分配制度 = 公会团装备归属的公会级策略,
 * 三选一、可更换但有转换成本:DKP 制 / GKP 制 / 会长裁量;自肥 = 会长利用
 * 分配权把装备分给自己的会长角色,累积忠诚与声望代价。
 * 规则逻辑在 src/sim/economy.ts(外快结算与团本掉落分配)与门面(换制裁决);
 * 此处只有数值与文案,调优不动模拟代码。
 * 自肥的声望代价自 T12 起从声望值实扣(content/reputation.ts 的声望系统)。
 */

import type { DungeonUnlockGates } from './dungeons';
import type { Quality } from './gear';

/** 公会金库(GLOSSARY)配置。 */
export interface VaultConfig {
  /** 建会时的金库起始余额。 */
  readonly startingGold: number;
}

export const VAULT: VaultConfig = {
  startingGold: 500,
};

/** 分配制度 id(GLOSSARY:三选一、可更换但有转换成本)。 */
export type LootSystemId = 'dkp' | 'gkp' | 'chairman';

/** 分配制度定义:制度心态(忠诚/心情)与金币流向的差异都写在这里。 */
export interface LootSystemDef {
  readonly id: LootSystemId;
  /** 制度名(UI 展示)。 */
  readonly name: string;
  /** 一句话制度风格(UI 展示)。 */
  readonly tagline: string;
  /** 制度详解:金币流向与人心代价写明(UI 展示)。 */
  readonly description: string;
  /** 转换成本:换入本制度的一次性金库支出(立规花费;金库付不起则换不成)。 */
  readonly switchCostGold: number;
  /** 转换成本:换入本制度时全员(会长角色除外)忠诚的一次性摩擦。 */
  readonly switchLoyaltyHit: number;
  /** 每个团本夜出席团员的忠诚调整(制度心态;会长角色除外)。 */
  readonly attendeeLoyaltyPerNight: number;
  /** 每个团本夜出席团员的心情调整。 */
  readonly attendeeMoodPerNight: number;
  /** DKP 制:每击杀一名首领,每名出席团员的 DKP 进账。 */
  readonly dkpPerBossKill?: number;
  /** DKP 制:按品质的 DKP 价目(赢家照价扣分,允许记负账)。 */
  readonly dkpPriceByQuality?: Readonly<Record<Quality, number>>;
  /** GKP 制:按品质的金币价目(出价须足额:个人金不足者不参拍)。 */
  readonly gkpPriceByQuality?: Readonly<Record<Quality, number>>;
  /** GKP 制:成交价入公会金库的比例 %(其余均分给出席团员,除不尽的零头归金库)。 */
  readonly gkpVaultCutPercent?: number;
  /** 会长裁量:自肥开启时,每件自肥装备对每名出席团员(会长角色除外)的忠诚代价。 */
  readonly selfDealLoyaltyCost?: number;
  /** 会长裁量:每件自肥装备的声望代价(自 T12 起从声望值实扣,见 content/reputation)。 */
  readonly selfDealReputationCost?: number;
}

/**
 * 三种分配制度(DESIGN「经济」:各有忠诚、金钱流向的代价收益):
 * - DKP 制:规则最公平,人心最稳(忠诚上涨),金币不流动;
 * - GKP 制:金库有抽成、全团有分红(心情上涨),人心按雇佣兵算(忠诚不涨);
 * - 会长裁量:装备去向完全可控,可自肥,但人治微损人心,自肥再叠加忠诚与声望代价。
 */
export const LOOT_SYSTEMS: readonly LootSystemDef[] = [
  {
    id: 'dkp',
    name: 'DKP 制',
    tagline: '出勤积分说话,多劳多得。',
    description:
      '击杀首领全员记 DKP,掉落按 DKP 高低调配(并列取编成靠前者),赢家照品质价目扣分、允许记负账。规则最公平:每夜出席者忠诚与心情都涨;金币不流动。',
    switchCostGold: 200,
    switchLoyaltyHit: 5,
    attendeeLoyaltyPerNight: 4,
    attendeeMoodPerNight: 2,
    dkpPerBossKill: 10,
    dkpPriceByQuality: { '白': 0, '绿': 15, '蓝': 25, '紫': 40 },
  },
  {
    id: 'gkp',
    name: 'GKP 制',
    tagline: '金币出价,价高者得。',
    description:
      '掉落按品质定价,个人金最足额者优先拍下(须出得起全价):成交价两成入公会金库、其余全团均分。金库有进账、团员有分红,心情看涨;但人心按雇佣兵算,忠诚不涨。',
    switchCostGold: 120,
    switchLoyaltyHit: 3,
    attendeeLoyaltyPerNight: 0,
    attendeeMoodPerNight: 4,
    gkpPriceByQuality: { '白': 0, '绿': 60, '蓝': 140, '紫': 320 },
    gkpVaultCutPercent: 20,
  },
  {
    id: 'chairman',
    name: '会长裁量',
    tagline: '装备去处,会长说了算。',
    description:
      '掉落由会长逐件裁量(缺省择优分配),并可开启自肥:装备优先装进会长自己的角色 —— 每件自肥都让出席团员忠诚受损、声望折价,代价逐件累积。人治本身也微损人心:每夜出席者忠诚略降。',
    switchCostGold: 0,
    switchLoyaltyHit: 2,
    attendeeLoyaltyPerNight: -2,
    attendeeMoodPerNight: 0,
    selfDealLoyaltyCost: 4,
    selfDealReputationCost: 2,
  },
];

/** 按制度 id 查定义(sim 结算与 UI 展示共用)。 */
export const LOOT_SYSTEM_BY_ID: ReadonlyMap<LootSystemId, LootSystemDef> = new Map(
  LOOT_SYSTEMS.map((system) => [system.id, system]),
);

/** 新会默认制度:初创小会,会长说了算(随时可依成本换制)。 */
export const DEFAULT_LOOT_SYSTEM: LootSystemId = 'chairman';

/** 外快活动 id(GLOSSARY:打工 = 出力换金币;野团 = 门槛低的临时混合团)。 */
export type ExternalActivityId = 'carry' | 'wildRaid';

/** 外快活动定义:小队整建制参加、收入归个人金(GLOSSARY:个人金)。 */
export interface ExternalActivityDef {
  readonly id: ExternalActivityId;
  /** 活动名(UI 展示)。 */
  readonly name: string;
  /** 一句话风情描述(UI 展示)。 */
  readonly description: string;
  /** 解锁门槛:公会平均等级 + 公会平均装等(与 5 人本同一判定)。 */
  readonly unlock: DungeonUnlockGates;
  /** 每游戏日每名队员的个人金收入。 */
  readonly goldPerMemberPerDay: number;
  /** 每游戏日每名队员的疲劳积累。 */
  readonly fatiguePerMemberPerDay: number;
}

/**
 * 外快活动表:野团门槛低、来钱细;G团打工门槛高、来钱粗。
 * (野团的基础装备掉落与 20 人休闲团本在后续工单接入,本票只做收入面。)
 */
export const EXTERNAL_ACTIVITIES: readonly ExternalActivityDef[] = [
  {
    id: 'wildRaid',
    name: '野团',
    description: '跟野团混个熟脸:门槛低、来钱细水长流,收入全归个人金。',
    unlock: { averageLevel: 30, averageItemLevel: 24 },
    goldPerMemberPerDay: 12,
    fatiguePerMemberPerDay: 10,
  },
  {
    id: 'carry',
    name: 'G团打工',
    description: '小队整建制出坞,替别家金团当打工仔:金币丰厚,直接入个人金。',
    unlock: { averageLevel: 40, averageItemLevel: 36 },
    goldPerMemberPerDay: 30,
    fatiguePerMemberPerDay: 12,
  },
];

/** 按活动 id 查定义(sim 结算与 UI 展示共用)。 */
export const EXTERNAL_ACTIVITY_BY_ID: ReadonlyMap<ExternalActivityId, ExternalActivityDef> =
  new Map(EXTERNAL_ACTIVITIES.map((activity) => [activity.id, activity]));
