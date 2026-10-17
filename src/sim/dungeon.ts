/**
 * 下本活动:5 人本的进驻校验、掉落生成、自动择优穿戴与逐日结算。
 *
 * 成败走统一结算引擎(sim/encounter.ts):装等/职能/光环 → 战力 → 三段式概率。
 * 一切可调数值在 content/dungeons.ts(数据驱动);
 * 纯函数、只走注入的种子随机链(成败掷点 → 掉落抽取,顺序固定)。
 * 演出级别(DESIGN「三级演出」):5 人本 = 结果卡 + 短日志 ——
 * 结算产出结构化 DungeonRunReport(结果卡数据)与逐条文本(短日志,经门面入事件流)。
 */

import {
  DUNGEONS,
  DUNGEON_BY_ID,
  DUNGEON_DROP_QUALITY,
  DUNGEON_SETTLEMENT,
  type DungeonDef,
} from '../content/dungeons';
import { GEAR_SLOTS, QUALITY_RULES, type GearSlot, type Quality } from '../content/gear';
import { LEVELING } from '../content/maps';
import { COMP } from '../content/comp';
import { composeSquad, memberRole } from './comp';
import { assessEncounter, rollEncounterOutcome } from './encounter';
import { averageItemLevel, guildAverageLevel } from './roster';
import { nextInt, pickOne, pickWeighted } from './rng';
import type { DropOutcome, DungeonRunReport, Member, Squad } from './state';

/** 5 人本解锁状态:按内容表顺序,标注当前是否可选(解锁门槛 = 公会平均等级)。 */
export interface DungeonStatus {
  readonly def: DungeonDef;
  readonly unlocked: boolean;
}

/** 全部 5 人本的解锁状态(派生量:随名册平均等级即时变化)。 */
export function dungeonStatuses(members: readonly Member[]): readonly DungeonStatus[] {
  const average = guildAverageLevel(members);
  return DUNGEONS.map((def) => ({ def, unlocked: average >= def.unlockAverageLevel }));
}

/** 小队当前进驻的 5 人本(活动缺失或副本不在内容表时为 undefined = 休整)。 */
export function squadDungeon(squad: Squad): DungeonDef | undefined {
  if (squad.activity?.type !== 'dungeon') {
    return undefined;
  }
  // 防御:内容表裁撤后存档里的旧副本 id 视同休整(不炸模拟)
  return DUNGEON_BY_ID.get(squad.activity.dungeonId);
}

/** 进本门槛未就绪的原因(满职能小队 = 满员 5 人 + 至少 1 坦 1 奶,GLOSSARY:职能)。 */
export type DungeonReadinessReason = '未满员' | '缺坦克' | '缺治疗';

export interface DungeonReadiness {
  readonly ready: boolean;
  readonly reasons: readonly DungeonReadinessReason[];
}

/** 判定一支小队是否满足进本门槛(会长指派时校验;结算时逐日复核)。 */
export function squadDungeonReadiness(
  squad: Squad,
  members: readonly Member[],
): DungeonReadiness {
  const resolved = squad.memberIds
    .map((id) => members.find((member) => member.id === id))
    .filter((member): member is Member => member !== undefined);
  const composition = composeSquad(squad, 1, resolved);

  const reasons: DungeonReadinessReason[] = [];
  if (resolved.length < COMP.squadSize) {
    reasons.push('未满员');
  }
  if (composition.roleCounts['坦克'] < COMP.squadStructure.minTanks) {
    reasons.push('缺坦克');
  }
  if (composition.roleCounts['治疗'] < COMP.squadStructure.minHealers) {
    reasons.push('缺治疗');
  }
  return { ready: reasons.length === 0, reasons };
}

/** 一件掉落(部位 + 品质 + 装等;穿戴去向由择优规则另行计算)。 */
export interface DroppedItem {
  readonly slot: GearSlot;
  readonly quality: Quality;
  readonly itemLevel: number;
}

/**
 * 掷出一次胜利的掉落(件数由副本配置):
 * 每件抽取顺序固定 = 部位(8 部位等概率)→ 品质(内容表权重)→ 装等扰动;
 * 装等 = 副本掉落基准 + 品质加成(content/gear)± 扰动(下限 1)。
 */
export function rollDrops(
  rngState: number,
  def: DungeonDef,
  count: number,
): [items: DroppedItem[], nextState: number] {
  let rng = rngState;
  const items: DroppedItem[] = [];
  for (let i = 0; i < count; i++) {
    const [slot, afterSlot] = pickOne(rng, GEAR_SLOTS);
    const [qualityRule, afterQuality] = pickWeighted(afterSlot, DUNGEON_DROP_QUALITY);
    const bonus =
      QUALITY_RULES.find((rule) => rule.quality === qualityRule.quality)?.itemLevelBonus ?? 0;
    const [jitter, afterJitter] = nextInt(
      afterQuality,
      -DUNGEON_SETTLEMENT.dropJitter,
      DUNGEON_SETTLEMENT.dropJitter,
    );
    rng = afterJitter;
    items.push({
      slot,
      quality: qualityRule.quality,
      itemLevel: Math.max(1, def.dropItemLevel + bonus + jitter),
    });
  }
  return [items, rng];
}

/** 择优穿戴:掉落归「该部位提升最大」的队员(并列取编入顺序靠前者)。 */
export function bestWearer(
  candidates: readonly Member[],
  item: DroppedItem,
): { member: Member; delta: number } {
  let best: { member: Member; delta: number } | undefined;
  for (const member of candidates) {
    const current = member.gear.find((gear) => gear.slot === item.slot);
    const delta = item.itemLevel - (current?.itemLevel ?? 0);
    if (best === undefined || delta > best.delta) {
      best = { member, delta };
    }
  }
  // 候选由进本门槛保证非空(满员 5 人)
  return best as { member: Member; delta: number };
}

/** 换装:替换该部位装备(不可变:返回新 gear 数组;部位缺失时追加到末尾)。 */
export function equipItem(member: Member, item: DroppedItem): Member {
  const index = member.gear.findIndex((gear) => gear.slot === item.slot);
  const piece = { slot: item.slot, quality: item.quality, itemLevel: item.itemLevel };
  const gear =
    index === -1
      ? [...member.gear, piece]
      : member.gear.map((gearItem, i) => (i === index ? piece : gearItem));
  return { ...member, gear };
}

/** 逐日结算入参。emit 把短日志文本交回门面(带时刻与序号入事件流)。 */
export interface SettleDungeonDayParams {
  readonly members: readonly Member[];
  readonly squads: readonly Squad[];
  readonly rngState: number;
  /** 本结算日边界(结果卡与日志的时刻)。 */
  readonly atGameMinutes: number;
  readonly emit: (text: string) => void;
}

export interface SettleDungeonDayResult {
  readonly members: readonly Member[];
  readonly rngState: number;
  /** 本日最后一次下本的结果卡数据(无任何下本时为 undefined) */
  readonly lastReport?: DungeonRunReport;
}

/**
 * 结算一个游戏日的下本活动(自动层,确定性):
 * 按编成顺序逐队、逐次结算 —— 战力评估(不掷点)→ 成败掷点 → 胜利掉落与择优穿戴
 * → 全员积劳;进本门槛在结算时逐日复核,人手不齐则暂停伐木(可观察、不炸模拟)。
 * 无小队下本时不消费随机链。
 */
export function settleDungeonDay(params: SettleDungeonDayParams): SettleDungeonDayResult {
  const { squads, atGameMinutes, emit } = params;
  let rngState = params.rngState;
  let members = params.members;
  let lastReport: DungeonRunReport | undefined;

  for (let squadIndex = 0; squadIndex < squads.length; squadIndex++) {
    const squad = squads[squadIndex]!;
    const def = squadDungeon(squad);
    if (def === undefined) {
      continue;
    }
    const ordinal = squadIndex + 1;

    // 门槛复核:淘汰/调离导致人手不齐时暂停(每日一条,可观察)
    const readiness = squadDungeonReadiness(squad, members);
    if (!readiness.ready) {
      emit(`第 ${ordinal} 小队下本暂停:${readiness.reasons.join('、')},补齐编成后自动恢复。`);
      continue;
    }

    for (let run = 1; run <= def.runsPerDay; run++) {
      const squadMembers = squad.memberIds
        .map((id) => members.find((member) => member.id === id))
        .filter((member): member is Member => member !== undefined);
      const composition = composeSquad(squad, ordinal, squadMembers);
      const auraBonusPercent =
        composition.auraBonus['伤害'] + composition.auraBonus['生存'] + composition.auraBonus['治疗'];
      const squadAverageItemLevel =
        squadMembers.reduce((sum, member) => sum + averageItemLevel(member), 0) / squadMembers.length;

      const assessment = assessEncounter(
        { averageItemLevel: squadAverageItemLevel, roleCounts: composition.roleCounts, auraBonusPercent },
        def.difficultyTarget,
      );
      const [success, afterRoll] = rollEncounterOutcome(rngState, assessment.successChance);
      rngState = afterRoll;

      // 全员积劳(下本是活动,不是休整;无论成败)
      members = members.map((member) =>
        squad.memberIds.includes(member.id)
          ? { ...member, fatigue: Math.min(LEVELING.maxFatigue, member.fatigue + def.fatiguePerRun) }
          : member,
      );

      // 参战名单快照(结算时刻,换装前的名字/职能/装等)
      const lineup = squadMembers.map((member) => ({
        name: member.name,
        role: memberRole(member) ?? '?',
        itemLevel: averageItemLevel(member),
      }));

      const chancePercent = Math.round(assessment.successChance * 100);
      let drops: readonly DropOutcome[] = [];
      if (success) {
        // 胜利:掉落 → 择优穿戴(逐件结算,后一件看到前一件的换装结果)
        const [dropped, afterDrops] = rollDrops(rngState, def, def.dropsPerRun);
        rngState = afterDrops;
        emit(
          `「${def.name}」速通:战力 ${Math.round(assessment.power)} 对难度 ${assessment.target}(胜率 ${chancePercent}%),缴获 ${dropped.length} 件装备。`,
        );
        const outcomes: DropOutcome[] = [];
        for (const item of dropped) {
          const fresh = squad.memberIds
            .map((id) => members.find((member) => member.id === id))
            .filter((member): member is Member => member !== undefined);
          const best = bestWearer(fresh, item);
          if (best.delta > 0) {
            members = members.map((member) =>
              member.id === best.member.id ? equipItem(member, item) : member,
            );
            outcomes.push({
              slot: item.slot,
              quality: item.quality,
              itemLevel: item.itemLevel,
              equipped: true,
              assignedTo: best.member.name,
              upgradeDelta: best.delta,
            });
            emit(
              `掉落:${item.quality}·${item.slot}(装等 ${item.itemLevel})→ ${best.member.name} 换上(+${best.delta})。`,
            );
          } else {
            outcomes.push({ slot: item.slot, quality: item.quality, itemLevel: item.itemLevel, equipped: false });
            emit(`掉落:${item.quality}·${item.slot}(装等 ${item.itemLevel})无人可提升,随手分解。`);
          }
        }
        drops = outcomes;
      } else {
        emit(
          `「${def.name}」败退:战力 ${Math.round(assessment.power)} 对难度 ${assessment.target}(胜率 ${chancePercent}%),整队无功而返。`,
        );
      }
      lastReport = {
        dungeonId: def.id,
        dungeonName: def.name,
        squadId: squad.id,
        squadOrdinal: ordinal,
        atGameMinutes,
        success,
        power: assessment.power,
        target: assessment.target,
        successChance: assessment.successChance,
        band: assessment.band,
        members: lineup,
        drops,
      };
    }
  }

  return { members, rngState, lastReport };
}
