/**
 * 练级活动:自动层的成长与疲劳结算(GLOSSARY:练级地图/高效区/休闲区)。
 *
 * 规则只存在于 sim;一切可调数值在 content/maps.ts(数据驱动)。
 * 纯函数、只走注入的种子随机链(阵亡判定);DESIGN「三级演出」中
 * 练级为静默计数 —— 结算不产生事件,成长与损耗经由状态与 UI 可观察。
 */

import { LEVELING, LEVELING_MAPS, LEVELING_MAP_BY_ID, type LevelingMapDef } from '../content/maps';
import { guildAverageLevel } from './roster';
import { nextFloat } from './rng';
import type { Member, Squad } from './state';

/** 升到下一级所需经验(等级 1..maxLevel-1;公式常量在 content/maps)。 */
export function xpToNextLevel(level: number): number {
  return LEVELING.xpCurve.perLevel * level + LEVELING.xpCurve.perLevelSquared * level * level;
}

/** 一名团员当前的经验效率(0-1):疲劳越高效率越低,有保底下限(数值在 content)。 */
export function xpEfficiency(fatigue: number): number {
  return Math.max(LEVELING.minEfficiency, 1 - fatigue * LEVELING.efficiencyLossPerFatigue);
}

/** 地图解锁状态:按内容表顺序,标注当前是否可选(解锁门槛 = 公会平均等级)。 */
export interface LevelingMapStatus {
  readonly def: LevelingMapDef;
  readonly unlocked: boolean;
}

/** 全部练级地图的解锁状态(派生量:随名册平均等级即时变化)。 */
export function levelingMapStatuses(members: readonly Member[]): readonly LevelingMapStatus[] {
  const average = guildAverageLevel(members);
  return LEVELING_MAPS.map((def) => ({ def, unlocked: average >= def.unlockAverageLevel }));
}

/** 小队当前的练级地图(活动缺失或地图不在内容表时为 undefined = 休整)。 */
export function squadLevelingMap(squad: Squad): LevelingMapDef | undefined {
  if (squad.activity?.type !== 'leveling') {
    return undefined;
  }
  // 防御:内容表裁撤后存档里的旧地图 id 视同休整(不炸模拟)
  return LEVELING_MAP_BY_ID.get(squad.activity.mapId);
}

/** 一个游戏日的自动层结算结果。 */
export interface LevelingDayResult {
  readonly members: readonly Member[];
  readonly rngState: number;
}

/**
 * 结算一个游戏日(自动层,确定性):
 * - 安排了练级地图的小队队员:获得经验(受疲劳效率修正)、可能阵亡
 *   (损失当日经验 + 额外疲劳)、积累疲劳、经验满则升级;
 * - 其余全员(待命或无安排小队):休整,疲劳自然恢复;
 * - 无任何练级安排时不消费随机链(阵亡判定逐人掷点,名册顺序即掷点顺序)。
 */
export function settleLevelingDay(
  members: readonly Member[],
  squads: readonly Squad[],
  rngState: number,
): LevelingDayResult {
  // 团员 → 其小队当前进驻的地图(一名团员只在一支小队内)
  const mapByMember = new Map<number, LevelingMapDef>();
  for (const squad of squads) {
    const map = squadLevelingMap(squad);
    if (map === undefined) {
      continue;
    }
    for (const memberId of squad.memberIds) {
      mapByMember.set(memberId, map);
    }
  }

  let rng = rngState;
  const settled: Member[] = [];
  let changed = false;

  for (const member of members) {
    const map = mapByMember.get(member.id);
    if (map === undefined) {
      // 休整:疲劳只降不升,已归零则原样保留(不重建对象)
      if (member.fatigue > 0) {
        settled.push({
          ...member,
          fatigue: Math.max(0, member.fatigue - LEVELING.restFatiguePerDay),
        });
        changed = true;
      } else {
        settled.push(member);
      }
      continue;
    }

    // 练级:经验收益(疲劳修正)→ 阵亡判定(唯一随机点)→ 结转升级
    let gained = Math.floor(map.xpPerDay * xpEfficiency(member.fatigue));
    const [deathRoll, nextRng] = nextFloat(rng);
    rng = nextRng;
    if (deathRoll < map.deathChancePerDay) {
      gained -= Math.floor((map.xpPerDay * LEVELING.death.xpLossPercent) / 100);
    }
    let experience = Math.max(0, member.experience + gained);
    let level = member.level;
    const fatigue = Math.min(
      LEVELING.maxFatigue,
      member.fatigue +
        map.fatiguePerDay +
        (deathRoll < map.deathChancePerDay ? LEVELING.death.fatiguePenalty : 0),
    );

    while (level < LEVELING.maxLevel) {
      const required = xpToNextLevel(level);
      if (experience < required) {
        break;
      }
      experience -= required;
      level += 1;
    }
    if (level >= LEVELING.maxLevel) {
      experience = 0; // 满级:经验条清零,不再累计
    }

    settled.push({ ...member, experience, level, fatigue });
    changed = true;
  }

  return { members: changed ? settled : members, rngState: rng };
}
