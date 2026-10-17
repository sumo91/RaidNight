/**
 * 内容阶梯引擎(GLOSSARY:内容阶梯):解锁门槛判定 + 内容表结构校验。
 *
 * 门槛与阶梯的「数值」全部在 content/(数据驱动);本模块只做两件纯函数工作:
 * 1) evaluateUnlockGates —— 把双维门槛(公会平均等级 + 公会平均装等)判成
 *    「已解锁 / 未达标项列表」,门面指令裁决与 UI 锁定文案共用同一结果;
 * 2) ladderIssues —— 校验内容表自身的阶梯完整性(等级带首尾相接、
 *    档位不跳级、紫装权重逐档抬升等)。新增内容只加数据时,由这份校验
 *    兜住「数据破坏阶梯结构」的错误 —— 不需要为新内容改任何代码。
 * GLOSSARY:内容阶梯不允许跳级;「未达标不可见/不可进入」即:
 * 派生量 unlocked = false(UI 不列入可进驻选项)+ 门面拒绝进驻指令。
 */

import {
  DUNGEONS,
  DUNGEON_TIERS,
  type DungeonDef,
  type DungeonTierDef,
} from '../content/dungeons';
import { LEVELING, LEVELING_MAPS, type LevelingMapDef } from '../content/maps';

/** 解锁门槛的当前公会刻度(名册派生量,见 sim/roster.ts)。 */
export interface GuildLadderMetrics {
  readonly averageLevel: number;
  readonly averageItemLevel: number;
}

/** 门槛判定结果:unlocked = 双维全部达标;unmet 为未达标项描述(已解锁为空)。 */
export interface UnlockEvaluation {
  readonly unlocked: boolean;
  readonly unmet: readonly string[];
}

/**
 * 判定一组双维门槛:任一维未达标即锁定。
 * 达标判定为 ≥(恰好压线即解锁);unmet 文案供 UI 锁定提示与测试断言共用。
 */
export function evaluateUnlockGates(
  gates: { readonly averageLevel: number; readonly averageItemLevel: number },
  metrics: GuildLadderMetrics,
): UnlockEvaluation {
  const unmet: string[] = [];
  if (metrics.averageLevel < gates.averageLevel) {
    unmet.push(`公会平均等级 ${gates.averageLevel}`);
  }
  if (metrics.averageItemLevel < gates.averageItemLevel) {
    unmet.push(`公会平均装等 ${gates.averageItemLevel}`);
  }
  return { unlocked: unmet.length === 0, unmet };
}

/** 参与结构校验的内容表集合(缺省取真实内容表;测试可传合成表)。 */
export interface LadderTables {
  readonly maps: readonly LevelingMapDef[];
  readonly dungeons: readonly DungeonDef[];
  readonly tiers: readonly DungeonTierDef[];
}

/** 真实内容表(新增内容 = 往 content/ 加数据,校验随之生效)。 */
export const LADDER_TABLES: LadderTables = {
  maps: LEVELING_MAPS,
  dungeons: DUNGEONS,
  tiers: DUNGEON_TIERS,
};

/**
 * 校验内容表的阶梯完整性,返回问题清单(空数组 = 表结构健康)。
 * 校验项:
 * - 地图:id 唯一;等级带落在 1..maxLevel;各阶段(按带下限分组)恰有高效/休闲各一张;
 *   等级带在 1..maxLevel 上首尾相接(上一带上限 + 1 = 下一带下限)、不重叠、不跳段。
 * - 难度档:order 自 1 连续;每档掉落品质权重合法;紫装权重随档位严格抬升(难度档差异)。
 * - 5 人本:id 唯一;档位存在于难度档表;数值为正;门槛双维随档位不下降(不跳级:
 *   更高档的门槛必须全面不低于更低档 —— 公会成长只能沿阶梯逐档解锁)。
 */
export function ladderIssues(tables: LadderTables = LADDER_TABLES): readonly string[] {
  const issues: string[] = [];
  const { maps, dungeons, tiers } = tables;

  // —— 地图:等级带结构 ——
  const mapIds = new Set<string>();
  for (const map of maps) {
    if (mapIds.has(map.id)) {
      issues.push(`地图 id 重复:${map.id}`);
    }
    mapIds.add(map.id);
    if (!(map.levelBand.min >= 1 && map.levelBand.min <= map.levelBand.max)) {
      issues.push(`地图「${map.name}」等级带非法(需 1 ≤ min ≤ max):${map.levelBand.min}–${map.levelBand.max}`);
    }
    if (map.levelBand.max > LEVELING.maxLevel) {
      issues.push(`地图「${map.name}」等级带上限超过等级上限(${LEVELING.maxLevel})`);
    }
  }
  if (maps.length > 0) {
    // 等级带按「阶段」检查:同阶段的高效/休闲两张共享同一条带,先按带下限去重
    const bandByMin = new Map<number, LevelingMapDef>();
    for (const map of maps) {
      if (!bandByMin.has(map.levelBand.min)) {
        bandByMin.set(map.levelBand.min, map);
      }
    }
    const sorted = [...bandByMin.values()].sort((a, b) => a.levelBand.min - b.levelBand.min);
    if (sorted[0]!.levelBand.min !== 1) {
      issues.push(`等级带未从 1 起(首带下限 ${sorted[0]!.levelBand.min})`);
    }
    for (let i = 0; i + 1 < sorted.length; i++) {
      const current = sorted[i]!;
      const next = sorted[i + 1]!;
      if (current.levelBand.max + 1 !== next.levelBand.min) {
        issues.push(
          `等级带不连续:${current.levelBand.min} 段的上限 ${current.levelBand.max} 与 ${next.levelBand.min} 段的下限应首尾相接`,
        );
      }
    }
    const last = sorted[sorted.length - 1]!;
    if (last.levelBand.max !== LEVELING.maxLevel) {
      issues.push(`等级带未铺到等级上限(末带上限 ${last.levelBand.max} ≠ ${LEVELING.maxLevel})`);
    }
    // 每阶段(同带)恰有高效/休闲各一张
    const stages = new Map<number, LevelingMapDef[]>();
    for (const map of maps) {
      const stage = stages.get(map.levelBand.min) ?? [];
      stage.push(map);
      stages.set(map.levelBand.min, stage);
    }
    for (const [min, stage] of stages) {
      const intensive = stage.filter((m) => m.tier === '高效');
      const relaxed = stage.filter((m) => m.tier === '休闲');
      if (intensive.length !== 1 || relaxed.length !== 1) {
        issues.push(`等级带 ${min} 起的阶段需恰有高效/休闲各一张(现为高效 ${intensive.length}、休闲 ${relaxed.length})`);
      }
    }
  }

  // —— 难度档表 ——
  const tierIds = new Set<string>();
  tiers.forEach((tier, index) => {
    if (tier.order !== index + 1) {
      issues.push(`难度档「${tier.id}」阶梯序应连续自 1 起(现为 ${tier.order},期望 ${index + 1})`);
    }
    if (tierIds.has(tier.id)) {
      issues.push(`难度档 id 重复:${tier.id}`);
    }
    tierIds.add(tier.id);
    const weightTotal = tier.dropQuality.reduce((sum, rule) => sum + Math.max(0, rule.weight), 0);
    if (weightTotal <= 0) {
      issues.push(`难度档「${tier.id}」掉落品质权重全为 0`);
    }
  });
  for (let i = 0; i + 1 < tiers.length; i++) {
    const purple = (tier: DungeonTierDef) =>
      tier.dropQuality.find((rule) => rule.quality === '紫')?.weight ?? 0;
    if (!(purple(tiers[i + 1]!) > purple(tiers[i]!))) {
      issues.push(`难度档「${tiers[i]!.id}」→「${tiers[i + 1]!.id}」紫装权重未严格抬升(${purple(tiers[i]!)} → ${purple(tiers[i + 1]!)})`);
    }
  }

  // —— 5 人本:档位引用、数值与门槛的阶梯序(档位以传入表为准,支持合成表校验) ——
  const orderOfTier = new Map(tiers.map((tier) => [tier.id as string, tier.order]));
  const dungeonIds = new Set<string>();
  const tierOrder = (dungeon: DungeonDef) => orderOfTier.get(dungeon.tier);
  for (const dungeon of dungeons) {
    if (dungeonIds.has(dungeon.id)) {
      issues.push(`5 人本 id 重复:${dungeon.id}`);
    }
    dungeonIds.add(dungeon.id);
    if (!orderOfTier.has(dungeon.tier)) {
      issues.push(`5 人本「${dungeon.name}」引用了不存在的难度档:${dungeon.tier}`);
    }
    if (
      dungeon.unlock.averageLevel < 1 ||
      dungeon.unlock.averageItemLevel < 0 ||
      dungeon.difficultyTarget < 1 ||
      dungeon.runsPerDay < 1 ||
      dungeon.dropsPerRun < 1 ||
      dungeon.dropItemLevel < 1
    ) {
      issues.push(`5 人本「${dungeon.name}」数值非法(门槛/难度/次数/掉落需为正数)`);
    }
  }
  for (const earlier of dungeons) {
    for (const later of dungeons) {
      if (
        tierOrder(later) !== undefined &&
        tierOrder(earlier) !== undefined &&
        tierOrder(later)! > tierOrder(earlier)! &&
        (later.unlock.averageLevel < earlier.unlock.averageLevel ||
          later.unlock.averageItemLevel < earlier.unlock.averageItemLevel)
      ) {
        issues.push(
          `门槛跳级:「${later.name}」(${later.tier}档)门槛低于「${earlier.name}」(${earlier.tier}档)`,
        );
      }
    }
  }

  return issues;
}
