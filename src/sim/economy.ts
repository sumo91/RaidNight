/**
 * 经济与分配制度(T11,GLOSSARY:经济与分配):
 * 双钱包(团员个人金 / 公会金库)、外快活动(打工/野团)与公会团分配制度
 * (DKP 制 / GKP 制 / 会长裁量,含自肥)。
 *
 * 金币流向约定(验收标准 1 的规则面):
 * - 打工/野团收入 → 团员个人金(公会金库不动);
 * - 5 人本掉落 → 小队内自动择优穿戴(小队私事,制度不管,见 sim/dungeon.ts);
 * - 团本掉落 → 按现行制度分配:
 *   · DKP 制:击杀记分、拿装扣分,金币不流动;
 *   · GKP 制:成交价从赢家个人金流出 → 金库抽成 + 全团均分(零头归金库,总量守恒);
 *   · 会长裁量:会长逐件裁量(缺省择优),自肥开启时装备优先装进会长角色,
 *     每件付出席者忠诚与声望代价(T12 起声望为真值,代价从声望值实扣)。
 *
 * 纯函数、不引入新随机:制度分配只做比较与整数运算(掉落本身的掷取仍在
 * sim/dungeon.ts 的种子随机链里),一切可调数值在 content/economy.ts。
 */

import {
  EXTERNAL_ACTIVITIES,
  EXTERNAL_ACTIVITY_BY_ID,
  type ExternalActivityDef,
  type ExternalActivityId,
  type LootSystemDef,
} from '../content/economy';
import { LEVELING } from '../content/maps';
import { evaluateUnlockGates } from './ladder';
import { squadDungeonReadiness, bestWearer, equipItem, type DroppedItem } from './dungeon';
import { guildAverageItemLevel, guildAverageLevel } from './roster';
import type { GuildVault, Member, Squad } from './state';

/** 外快活动解锁状态(派生量:随公会平均等级与平均装等即时变化;UI 锁定文案共用)。 */
export interface ExternalActivityStatus {
  readonly def: ExternalActivityDef;
  readonly unlocked: boolean;
  /** 未达标门槛描述(空数组 = 已解锁;与 5 人本同一文案体系)。 */
  readonly unmet: readonly string[];
}

/** 全部外快活动的解锁状态(内容表顺序:野团 → G团打工)。 */
export function externalActivityStatuses(members: readonly Member[]): readonly ExternalActivityStatus[] {
  const metrics = { averageLevel: guildAverageLevel(members), averageItemLevel: guildAverageItemLevel(members) };
  return EXTERNAL_ACTIVITIES.map((def) => {
    const evaluation = evaluateUnlockGates(def.unlock, metrics);
    return { def, unlocked: evaluation.unlocked, unmet: evaluation.unmet };
  });
}

/** 小队当前的外快活动(打工/野团;无此安排时为 undefined = 休整或在做别的)。 */
export function squadExternalActivity(squad: Squad): ExternalActivityDef | undefined {
  if (squad.activity?.type !== 'carry' && squad.activity?.type !== 'wildRaid') {
    return undefined;
  }
  return EXTERNAL_ACTIVITY_BY_ID.get(squad.activity.type);
}

/** 外快逐日结算入参。emit 把短日志文本交回门面(带时刻与序号入事件流)。 */
export interface SettleExternalDayParams {
  readonly members: readonly Member[];
  readonly squads: readonly Squad[];
  readonly atGameMinutes: number;
  readonly emit: (text: string) => void;
}

/**
 * 结算一个游戏日的外快活动(自动层,确定性、不消费随机链):
 * 按编成顺序逐队 —— 满职能复核(与下本同一门槛:满员 5 人 + 至少 1 坦 1 奶),
 * 人手不齐则暂停并留一条可观察日志;合格则每人收入入个人金、积劳。
 * 无小队外快时状态原样返回。
 */
export function settleExternalDay(params: SettleExternalDayParams): { readonly members: readonly Member[] } {
  let members = params.members;
  for (const [index, squad] of params.squads.entries()) {
    const def = squadExternalActivity(squad);
    if (def === undefined) {
      continue;
    }
    const ordinal = index + 1;
    const readiness = squadDungeonReadiness(squad, members);
    if (!readiness.ready) {
      params.emit(`第 ${ordinal} 小队的${def.name}暂停:${readiness.reasons.join('、')},补齐编成后自动恢复。`);
      continue;
    }
    members = members.map((member) =>
      squad.memberIds.includes(member.id)
        ? {
            ...member,
            personalGold: member.personalGold + def.goldPerMemberPerDay,
            fatigue: Math.min(LEVELING.maxFatigue, member.fatigue + def.fatiguePerMemberPerDay),
          }
        : member,
    );
    params.emit(
      `第 ${ordinal} 小队完成${def.name}:每人 +${def.goldPerMemberPerDay} 金入个人金,疲劳 +${def.fatiguePerMemberPerDay}。`,
    );
  }
  return { members };
}

/** 团本掉落分配入参:制度、自肥开关与双钱包快照一并传入(分配可能同时动两个钱包)。 */
export interface DistributeRaidDropParams {
  readonly members: readonly Member[];
  /** 出战阵容(按小队顺序、队内顺序;赢家并列取靠前者)。 */
  readonly team: readonly Member[];
  readonly item: DroppedItem;
  readonly system: LootSystemDef;
  /** 会长裁量制下的自肥开关(他制忽略)。 */
  readonly selfDealing: boolean;
  readonly vault: GuildVault;
}

/** 团本掉落分配结果:新状态 + 去向记录 + 结算文本(经门面入「团本」事件流)。 */
export interface RaidDropAllocation {
  readonly members: readonly Member[];
  readonly vault: GuildVault;
  /** 是否自肥件(会长裁量 + 自肥生效)。 */
  readonly selfDealt: boolean;
  /** 本件的声望代价(自肥件为内容表值,其余为 0;由调用方从声望中扣减并累积)。 */
  readonly reputationCost: number;
  /** DropOutcome 的去向字段(equipped/assignedTo/upgradeDelta/goldPaid/dkpPaid/selfDealt/unequippedReason)。 */
  readonly outcome: {
    readonly equipped: boolean;
    readonly assignedTo?: string;
    readonly upgradeDelta?: number;
    readonly goldPaid?: number;
    readonly dkpPaid?: number;
    readonly selfDealt?: boolean;
    readonly unequippedReason?: '流拍';
  };
  /** 结算文本(一条或零条;无人可提升的分解文案也在此给出)。 */
  readonly line?: string;
}

/** 掉落对某团员的装等提升(该部位现值之差;无人可提升 = 全员 ≤ 0)。 */
function upgradeDeltaOf(member: Member, item: DroppedItem): number {
  const current = member.gear.find((gear) => gear.slot === item.slot);
  return item.itemLevel - (current?.itemLevel ?? 0);
}

/** 忠诚钳制(0-100;会长角色恒 100 由调用方保证不在此调整)。 */
function clampLoyalty(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * 按现行制度分配一件团本掉落(确定性,不掷随机):
 * - DKP 制:DKP 最高且可提升者优先(并列取阵容靠前者),照品质价目扣分(允许负账);
 * - GKP 制:出得起全价且可提升者中个人金最足者优先,成交价金库抽成 + 全团均分;
 * - 会长裁量:自肥开启且会长角色在阵中可提升 → 装进会长角色(付忠诚/声望代价),
 *   否则择优分配(裁量缺省 = 合理分配)。
 * 无人可提升一律分解;GKP 无人出得起全价则流拍分解。
 */
export function distributeRaidDrop(params: DistributeRaidDropParams): RaidDropAllocation {
  const { team, item, system, vault } = params;
  const label = `${item.quality}·${item.slot}(装等 ${item.itemLevel})`;
  const teamIds = new Set(team.map((member) => member.id));
  const candidates = team.filter((member) => upgradeDeltaOf(member, item) > 0);

  if (candidates.length === 0) {
    return {
      members: params.members,
      vault,
      selfDealt: false,
      reputationCost: 0,
      outcome: { equipped: false },
      line: `团本掉落:${label} 无人可提升,随手分解。`,
    };
  }

  // 并列取阵容靠前者:maxBy 用严格大于比较,先到先得
  const maxBy = <T>(list: readonly T[], score: (entry: T) => number): T => {
    let best = list[0] as T;
    for (const entry of list) {
      if (score(entry) > score(best)) {
        best = entry;
      }
    }
    return best;
  };

  if (system.id === 'dkp') {
    const winner = maxBy(candidates, (member) => member.dkp);
    const delta = upgradeDeltaOf(winner, item);
    const price = system.dkpPriceByQuality?.[item.quality] ?? 0;
    const paidDkp = winner.dkp - price;
    const members = params.members.map((member) =>
      member.id === winner.id ? equipItem({ ...member, dkp: paidDkp }, item) : member,
    );
    return {
      members,
      vault,
      selfDealt: false,
      reputationCost: 0,
      outcome: {
        equipped: true,
        assignedTo: winner.name,
        upgradeDelta: delta,
        dkpPaid: price,
      },
      line: `团本掉落:${label} → ${winner.name} 换上(+${delta}),扣 ${price} DKP(余 ${paidDkp};DKP 制)。`,
    };
  }

  if (system.id === 'gkp') {
    const price = system.gkpPriceByQuality?.[item.quality] ?? 0;
    const bidders = candidates.filter((member) => member.personalGold >= price);
    if (bidders.length === 0) {
      return {
        members: params.members,
        vault,
        selfDealt: false,
        reputationCost: 0,
        outcome: { equipped: false, unequippedReason: '流拍' },
        line: `团本掉落:${label} 流拍 —— 全团无人出得起 ${price} 金,随手分解(GKP 制)。`,
      };
    }
    const winner = maxBy(bidders, (member) => member.personalGold);
    const delta = upgradeDeltaOf(winner, item);
    // 成交价拆分:金库抽成 → 其余全团均分 → 除不尽的零头归金库(总量守恒)
    const vaultCut = Math.floor((price * (system.gkpVaultCutPercent ?? 0)) / 100);
    const pot = price - vaultCut;
    const share = Math.floor(pot / team.length);
    const leftover = pot - share * team.length;
    const members = params.members.map((member) => {
      if (member.id === winner.id) {
        // 赢家付全价,同时作为出席团员领取一份分红
        return equipItem({ ...member, personalGold: member.personalGold - price + share }, item);
      }
      return teamIds.has(member.id) ? { ...member, personalGold: member.personalGold + share } : member;
    });
    const vaultGain = vaultCut + leftover;
    const vaultAfter: GuildVault = {
      gold: vault.gold + vaultGain,
      repairSpent: vault.repairSpent,
      incomeTotal: vault.incomeTotal + vaultGain,
    };
    return {
      members,
      vault: vaultAfter,
      selfDealt: false,
      reputationCost: 0,
      outcome: {
        equipped: true,
        assignedTo: winner.name,
        upgradeDelta: delta,
        goldPaid: price,
      },
      line: `团本掉落:${label} → ${winner.name} 拍下,付 ${price} 金(金库 +${vaultGain},全团每人分 ${share} 金;GKP 制)。`,
    };
  }

  // 会长裁量:自肥优先(会长角色在阵中且可提升),否则择优分配
  const chairman = params.members.find((member) => member.isChairman);
  if (params.selfDealing && chairman !== undefined && teamIds.has(chairman.id) && upgradeDeltaOf(chairman, item) > 0) {
    const delta = upgradeDeltaOf(chairman, item);
    const loyaltyCost = system.selfDealLoyaltyCost ?? 0;
    const reputationCost = system.selfDealReputationCost ?? 0;
    const members = params.members.map((member) => {
      if (member.id === chairman.id) {
        return equipItem(member, item);
      }
      // 出席团员(会长角色除外)逐件付出忠诚代价;忠诚不波及未出战者
      return teamIds.has(member.id)
        ? { ...member, loyalty: clampLoyalty(member.loyalty - loyaltyCost) }
        : member;
    });
    return {
      members,
      vault,
      selfDealt: true,
      reputationCost,
      outcome: {
        equipped: true,
        assignedTo: chairman.name,
        upgradeDelta: delta,
        selfDealt: true,
      },
      line: `团本掉落:${label} → 会长角色 强行收下(+${delta};自肥:出席者忠诚 −${loyaltyCost},声望 −${reputationCost})。`,
    };
  }

  const fair = bestWearer(candidates, item);
  const members = params.members.map((member) =>
    member.id === fair.member.id ? equipItem(member, item) : member,
  );
  return {
    members,
    vault,
    selfDealt: false,
    reputationCost: 0,
    outcome: { equipped: true, assignedTo: fair.member.name, upgradeDelta: fair.delta },
    line: `团本掉落:${label} → ${fair.member.name} 换上(+${fair.delta};会长裁量)。`,
  };
}

/** 夜末制度心态调整:出席团员忠诚(会长角色除外)与心情按内容表增减(钳制 0-100)。 */
export function applyLootSystemNightEffects(
  members: readonly Member[],
  teamIds: ReadonlySet<number>,
  system: LootSystemDef,
): readonly Member[] {
  return members.map((member) => {
    if (!teamIds.has(member.id)) {
      return member;
    }
    return {
      ...member,
      loyalty: member.isChairman ? member.loyalty : clampLoyalty(member.loyalty + system.attendeeLoyaltyPerNight),
      mood: Math.max(0, Math.min(100, member.mood + system.attendeeMoodPerNight)),
    };
  });
}

/** DKP 记分:击杀一名首领,每名出席团员 +dkpPerBossKill(仅 DKP 制;含会长角色)。 */
export function accrueDkpOnKill(
  members: readonly Member[],
  teamIds: ReadonlySet<number>,
  system: LootSystemDef,
): readonly Member[] {
  const gain = system.dkpPerBossKill ?? 0;
  if (gain === 0) {
    return members;
  }
  return members.map((member) => (teamIds.has(member.id) ? { ...member, dkp: member.dkp + gain } : member));
}

/** 外快活动 id → 活动队列用的类别标签(sim/schedule 与 UI 共用)。 */
export function externalActivityKindLabel(id: ExternalActivityId): '打工' | '野团' {
  return id === 'carry' ? '打工' : '野团';
}
