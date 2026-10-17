import { describe, expect, it } from 'vitest';
import {
  DUNGEONS,
  DUNGEON_BY_ID,
  DUNGEON_TIERS,
  DUNGEON_TIER_BY_ID,
  type DungeonDef,
} from '../content/dungeons';
import { GEAR_SLOTS, type Quality } from '../content/gear';
import { LEVELING_MAPS } from '../content/maps';
import { GAME_MINUTES_PER_DAY } from './clock';
import { dungeonStatuses, rollDrops, type DroppedItem } from './dungeon';
import { SimulationFacade } from './facade';
import { LADDER_TABLES, evaluateUnlockGates, ladderIssues } from './ladder';
import { levelingMapStatuses } from './leveling';
import { guildAverageItemLevel } from './roster';
import type { GameState, GearItem, Member, Squad } from './state';

/**
 * T8 门面测试:内容阶梯 —— 难度档表 + 解锁门槛。
 * 与全项目一致只打门面接缝:驱动 SimulationFacade 断言状态快照与事件日志;
 * evaluateUnlockGates / dungeonStatuses / ladderIssues 为 sim 纯函数,按 T2-T6 先例直接断言。
 * 数值断言全部用内容常量独立重算(不复用判定实现的代码路径)。
 */

const SEED = 20261018;

/** 合成团员:等级与全身装等可控(二者即双维解锁刻度);职能按标准编成。 */
function synthMember(
  id: number,
  classId: string,
  specId: string,
  level: number,
  itemLevel: number,
): Member {
  return {
    id,
    isChairman: false,
    name: `合成团员${id}`,
    classId,
    specId,
    level,
    experience: 0,
    gear: GEAR_SLOTS.map((slot) => ({ slot, quality: '白' as const, itemLevel })) as GearItem[],
    mood: 80,
    loyalty: 80,
    personalGold: 0,
    dkp: 0,
    fatigue: 0,
    attendance: { styleId: 'iron', baseRate: 95 },
    traits: [],
    skillTierId: 'skilled',
  };
}

/** 标准编成:1 坦(战士·铁壁)+ 1 奶(牧师·圣言)+ 3 输出(法师三系);全队同等级同装等。 */
function standardSquad(level: number, itemLevel: number): Member[] {
  const make = (id: number, classId: string, specId: string) =>
    synthMember(id, classId, specId, level, itemLevel);
  return [
    make(1, 'warrior', 'warrior-guard'),
    make(2, 'priest', 'priest-light'),
    make(3, 'mage', 'mage-arcane'),
    make(4, 'mage', 'mage-flame'),
    make(5, 'mage', 'mage-frost'),
  ];
}

/** 以真实初始状态为底,替换名册与编成(名册 = 小队 5 人 ⇒ 公会刻度 = 编成刻度)。 */
function squadState(members: readonly Member[], squad?: Squad): GameState {
  const base = new SimulationFacade(SEED, '测试公会').state;
  const maxMemberId = members.reduce((max, m) => Math.max(max, m.id), 0);
  return {
    ...base,
    members,
    nextMemberId: maxMemberId + 1,
    squads: [squad ?? { id: 1, memberIds: members.map((m) => m.id) }],
    nextSquadId: 2,
  };
}

/** 公会刻度恰好等于给定值的合成名册(全员同等级、同全身装等)。 */
function rosterAt(averageLevel: number, averageItemLevel: number): readonly Member[] {
  return standardSquad(averageLevel, averageItemLevel);
}

const FIRST = DUNGEON_BY_ID.get('echo-catacomb') as DungeonDef;
const HERO = DUNGEON_BY_ID.get('burning-sanctum') as DungeonDef;

describe('内容表数据驱动:难度档表与等级带(验收标准 1 与 3)', () => {
  it('难度档表四档有序:普通 → 高级 → 困难 → 英雄,配置完整', () => {
    expect(DUNGEON_TIERS.map((tier) => tier.id)).toEqual(['普通', '高级', '困难', '英雄']);
    for (const [index, tier] of DUNGEON_TIERS.entries()) {
      expect(tier.order).toBe(index + 1);
      expect(tier.description.length).toBeGreaterThan(0);
      expect(tier.dropQuality.reduce((sum, rule) => sum + rule.weight, 0)).toBeGreaterThan(0);
    }
  });

  it('首批内容覆盖四档;地图等级带覆盖 1..60 全程', () => {
    const tiersCovered = new Set(DUNGEONS.map((d) => d.tier));
    expect(tiersCovered).toEqual(new Set(['普通', '高级', '困难', '英雄']));
    expect(DUNGEONS.length).toBeGreaterThanOrEqual(8);

    const bands = [...LEVELING_MAPS].sort((a, b) => a.levelBand.min - b.levelBand.min);
    expect(bands[0]!.levelBand.min).toBe(1);
    expect(bands[bands.length - 1]!.levelBand.max).toBe(60);
  });

  it('真实内容表通过阶梯完整性校验(结构健康 = 新增数据的护栏)', () => {
    expect(ladderIssues(LADDER_TABLES)).toEqual([]);
    expect(ladderIssues()).toEqual([]); // 缺省入参即真实表
  });

  it('新增内容只加数据:合成的新副本并入表即通过校验,无需任何代码改动', () => {
    const extra: DungeonDef = {
      id: 'test-extra-spire',
      name: '测试尖塔',
      description: '合成数据:验证扩表只需追加条目。',
      tier: '英雄',
      unlock: { averageLevel: 60, averageItemLevel: 70 },
      difficultyTarget: 110,
      runsPerDay: 1,
      dropsPerRun: 3,
      dropItemLevel: 80,
      fatiguePerRun: 15,
    };
    expect(ladderIssues({ ...LADDER_TABLES, dungeons: [...DUNGEONS, extra] })).toEqual([]);
  });

  it('校验护栏是数据级的:跳级门槛、未知档位、等级带断档、重复 id、档位掉落退化都会被点名', () => {
    // 门槛跳级:英雄档的装等门槛低于普通档
    const skipping: DungeonDef = {
      ...HERO,
      id: 'test-skip',
      unlock: { averageLevel: 99, averageItemLevel: 0 },
    };
    expect(ladderIssues({ ...LADDER_TABLES, dungeons: [...DUNGEONS, skipping] }).join('\n')).toContain('门槛跳级');

    // 未知档位(脏数据模拟:运行时校验目标,类型上显式越界)
    const mistiered: DungeonDef = { ...FIRST, id: 'test-mistier', tier: '史诗' as DungeonDef['tier'] };
    expect(ladderIssues({ ...LADDER_TABLES, dungeons: [...DUNGEONS, mistiered] }).join('\n')).toContain('不存在的难度档');

    // 等级带断档:雾沼上限改 24 → 与黑松林穴(26 起)之间缺口 25
    const gapped = LEVELING_MAPS.map((m) =>
      m.id === 'mistmarsh' ? { ...m, levelBand: { min: 14, max: 24 } } : m,
    );
    expect(ladderIssues({ ...LADDER_TABLES, maps: gapped }).join('\n')).toContain('等级带不连续');

    // 重复 id
    expect(
      ladderIssues({ ...LADDER_TABLES, dungeons: [...DUNGEONS, { ...FIRST }] }).join('\n'),
    ).toContain('id 重复');

    // 档位掉落退化:英雄档紫装权重不高于困难档
    const flatTiers = DUNGEON_TIERS.map((tier) =>
      tier.id === '英雄' ? { ...tier, dropQuality: tier.dropQuality.map((rule) => ({ ...rule, weight: rule.quality === '紫' ? 15 : rule.weight })) } : tier,
    );
    expect(ladderIssues({ ...LADDER_TABLES, tiers: flatTiers }).join('\n')).toContain('紫装权重未严格抬升');
  });
});

describe('公会刻度与双维门槛判定(验收标准 2 的判定面)', () => {
  it('guildAverageItemLevel = 全员装等均值的向下取整(空名册为 0;无装备计 0)', () => {
    expect(guildAverageItemLevel([])).toBe(0);
    expect(guildAverageItemLevel(rosterAt(20, 13))).toBe(13);
    // (10 + 13 + 12) / 3 = 11.67 → 11
    const mixed = [synthMember(1, 'mage', 'mage-arcane', 20, 10), synthMember(2, 'mage', 'mage-flame', 20, 13), synthMember(3, 'mage', 'mage-frost', 20, 12)];
    expect(guildAverageItemLevel(mixed)).toBe(11);
    const naked = synthMember(1, 'mage', 'mage-arcane', 20, 0);
    expect(guildAverageItemLevel([naked, synthMember(2, 'mage', 'mage-flame', 20, 10)])).toBe(5);
  });

  it('evaluateUnlockGates:双维任一未达标即锁定;压线(恰好等于)即解锁;unmet 点名缺口', () => {
    expect(evaluateUnlockGates({ averageLevel: 10, averageItemLevel: 8 }, { averageLevel: 9, averageItemLevel: 20 })).toEqual({
      unlocked: false,
      unmet: ['公会平均等级 10'],
    });
    expect(evaluateUnlockGates({ averageLevel: 10, averageItemLevel: 8 }, { averageLevel: 20, averageItemLevel: 7 })).toEqual({
      unlocked: false,
      unmet: ['公会平均装等 8'],
    });
    expect(evaluateUnlockGates({ averageLevel: 10, averageItemLevel: 8 }, { averageLevel: 10, averageItemLevel: 8 })).toEqual({
      unlocked: true,
      unmet: [],
    });
    // 双缺口:两项都点名,顺序固定(等级在前)
    expect(evaluateUnlockGates({ averageLevel: 10, averageItemLevel: 8 }, { averageLevel: 9, averageItemLevel: 7 }).unmet).toEqual([
      '公会平均等级 10',
      '公会平均装等 8',
    ]);
  });

  it('dungeonStatuses:解锁状态随双维刻度即时变化,unmet 与门槛一致', () => {
    const shortLevel = dungeonStatuses(rosterAt(9, 20)).find((s) => s.def.id === FIRST.id);
    expect(shortLevel?.unlocked).toBe(false);
    expect(shortLevel?.unmet).toEqual(['公会平均等级 10']);

    const shortGear = dungeonStatuses(rosterAt(20, 7)).find((s) => s.def.id === FIRST.id);
    expect(shortGear?.unlocked).toBe(false);
    expect(shortGear?.unmet).toEqual(['公会平均装等 8']);

    const atGate = dungeonStatuses(rosterAt(10, 8)).find((s) => s.def.id === FIRST.id);
    expect(atGate?.unlocked).toBe(true);
    expect(atGate?.unmet).toEqual([]);
  });
});

describe('解锁门槛生效:未达标不可进入(验收标准 2,经门面)', () => {
  it('等级未达标:进驻指令被忽略,状态与日志均无变化', () => {
    const facade = new SimulationFacade(SEED, '测试公会', squadState(standardSquad(9, 20)));
    const before = structuredClone(facade.state);
    const blocked = facade.dispatch({
      command: { type: 'assignDungeon', squadId: 1, dungeonId: FIRST.id },
      deltaGameMinutes: 0,
    });
    expect(blocked.events).toEqual([]);
    expect(facade.state.squads[0]?.activity).toBeUndefined();
    expect(facade.state).toEqual(before);
  });

  it('装等未达标(等级已过线):同样被忽略 —— 装等是独立生效的第二维门槛', () => {
    const advanced = DUNGEON_BY_ID.get('clockwork-deepcity') as DungeonDef; // 门槛 {22,18}
    const facade = new SimulationFacade(SEED, '测试公会', squadState(standardSquad(30, 17)));
    const blocked = facade.dispatch({
      command: { type: 'assignDungeon', squadId: 1, dungeonId: advanced.id },
      deltaGameMinutes: 0,
    });
    expect(blocked.events).toEqual([]);
    expect(facade.state.squads[0]?.activity).toBeUndefined();

    // 换上达标装备(名册装等 17 → 18)后,同一指令获准 —— 门槛随装等成长放开
    const geared = squadState(standardSquad(30, 18));
    facade.restore(geared);
    const assigned = facade.dispatch({
      command: { type: 'assignDungeon', squadId: 1, dungeonId: advanced.id },
      deltaGameMinutes: 0,
    });
    expect(assigned.events.map((e) => [e.kind, e.text])).toEqual([
      ['下本', `第 1 小队进驻「${advanced.name}」(高级档),每日自动下本 ${advanced.runsPerDay} 次。`],
    ]);
    expect(facade.state.squads[0]?.activity).toEqual({ type: 'dungeon', dungeonId: advanced.id });
  });

  it('双维压线即解锁:等级 10、装等 8 恰好进驻回声墓道', () => {
    const facade = new SimulationFacade(SEED, '测试公会', squadState(standardSquad(10, 8)));
    const assigned = facade.dispatch({
      command: { type: 'assignDungeon', squadId: 1, dungeonId: FIRST.id },
      deltaGameMinutes: 0,
    });
    expect(assigned.events).toHaveLength(1);
    expect(facade.state.squads[0]?.activity).toEqual({ type: 'dungeon', dungeonId: FIRST.id });
  });

  it('练级地图同受等级带门槛:未到带的地图不可进驻(未达标不可见/不可进入)', () => {
    const facade = new SimulationFacade(SEED, '测试公会', squadState(standardSquad(9, 20)));
    const locked = levelingMapStatuses(facade.state.members).find((s) => s.def.id === 'windworn-hills');
    expect(locked?.unlocked).toBe(false); // 带 38 起,当前 9

    const blocked = facade.dispatch({
      command: { type: 'assignLevelingMap', squadId: 1, mapId: 'windworn-hills' },
      deltaGameMinutes: 0,
    });
    expect(blocked.events).toEqual([]);
    expect(facade.state.squads[0]?.activity).toBeUndefined();
  });
});

describe('不跳级:门槛随档位递增,公会只能沿阶梯逐档解锁(验收标准 5)', () => {
  it('站在任一副本自己的门槛上:低档副本必已全部解锁、本副本压线解锁', () => {
    for (const dungeon of DUNGEONS) {
      const ownOrder = DUNGEON_TIER_BY_ID.get(dungeon.tier)!.order;
      const statuses = dungeonStatuses(rosterAt(dungeon.unlock.averageLevel, dungeon.unlock.averageItemLevel));
      for (const status of statuses) {
        const order = DUNGEON_TIER_BY_ID.get(status.def.tier)!.order;
        if (order < ownOrder) {
          expect(status.unlocked).toBe(true); // 更低档永远先一步解锁
        }
      }
      expect(statuses.find((s) => s.def.id === dungeon.id)?.unlocked).toBe(true);
    }
  });

  it('公会刻度沿阶梯爬升:已解锁副本数单调不减,且四档首见顺序 = 普通 → 高级 → 困难 → 英雄', () => {
    // 沿内容表逐站爬升(每站 = 下一座副本的门槛),记录每档首次解锁出现的站点序
    const firstSeen = new Map<string, number>();
    let unlockedCount = -1;
    for (const [stop, dungeon] of DUNGEONS.entries()) {
      const statuses = dungeonStatuses(rosterAt(dungeon.unlock.averageLevel, dungeon.unlock.averageItemLevel));
      const count = statuses.filter((s) => s.unlocked).length;
      expect(count).toBeGreaterThanOrEqual(unlockedCount); // 只增不减(不跳级 ⇒ 无回跳)
      unlockedCount = count;
      for (const status of statuses) {
        if (status.unlocked && !firstSeen.has(status.def.tier)) {
          firstSeen.set(status.def.tier, stop);
        }
      }
    }
    expect([...firstSeen.entries()].sort((a, b) => a[1] - b[1]).map(([tier]) => tier)).toEqual([
      '普通',
      '高级',
      '困难',
      '英雄',
    ]);
  });
});

describe('难度档差异(验收标准 5)', () => {
  it('掉落品质分布逐档抬升:紫装权重严格递增、英雄档不掉白装(内容表面)', () => {
    const purple = (tierIndex: number) =>
      DUNGEON_TIERS[tierIndex]!.dropQuality.find((rule) => rule.quality === '紫')!.weight;
    for (let i = 0; i + 1 < DUNGEON_TIERS.length; i++) {
      expect(purple(i + 1)).toBeGreaterThan(purple(i));
    }
    const heroWhite = DUNGEON_TIERS[3]!.dropQuality.find((rule) => rule.quality === '白')!.weight;
    expect(heroWhite).toBe(0);
  });

  it('同一随机链实测:英雄档紫装率显著高于普通档,且英雄档不掉白装', () => {
    const sample = (def: DungeonDef): Record<Quality, number> => {
      let rng = 20260818;
      const counts: Record<Quality, number> = { 白: 0, 绿: 0, 蓝: 0, 紫: 0 };
      const N = 2400;
      for (let i = 0; i < N; i++) {
        const [items, next] = rollDrops(rng, def, 1);
        rng = next;
        counts[(items[0] as DroppedItem).quality] += 1;
      }
      return counts;
    };
    const normal = sample(FIRST);
    const hero = sample(HERO);
    expect(hero['紫'] / 2400).toBeGreaterThan(normal['紫'] / 2400); // 20% vs 5%
    expect(hero['白']).toBe(0);
    expect(normal['紫'] / 2400).toBeLessThan(0.09);
    expect(hero['紫'] / 2400).toBeGreaterThan(0.15);
  });

  it('同队打不同档:普通档速通、英雄档必败 —— 难度目标与结算结果随档位拉开(经门面)', () => {
    const squad = standardSquad(30, 30); // 战力约 (30+21)×1.19 ≈ 61
    const run = (dungeonId: string): GameState => {
      const facade = new SimulationFacade(
        SEED,
        '测试公会',
        squadState(squad, {
          id: 1,
          memberIds: squad.map((m) => m.id),
          activity: { type: 'dungeon', dungeonId },
        }),
      );
      facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
      return facade.state;
    };
    const normalRun = run(FIRST.id);
    const heroRun = run(HERO.id);
    expect(normalRun.lastDungeonRun?.target).toBe(FIRST.difficultyTarget); // 36
    expect(heroRun.lastDungeonRun?.target).toBe(HERO.difficultyTarget); // 96
    expect(normalRun.lastDungeonRun?.success).toBe(true); // 超配必胜
    expect(normalRun.lastDungeonRun?.band).toBe('必胜');
    expect(heroRun.lastDungeonRun?.success).toBe(false); // 低配必败
    expect(heroRun.lastDungeonRun?.band).toBe('必败');
    // 英雄档无掉落;普通档掉落装等读自本档内容表
    expect(heroRun.lastDungeonRun?.drops).toHaveLength(0);
    expect(normalRun.lastDungeonRun?.drops.length).toBe(FIRST.dropsPerRun);
  });

  it('难度与掉落档位沿阶梯单调:高档副本的难度目标与掉落装等不低于低档(独立重算)', () => {
    const orderOf = (d: DungeonDef) => DUNGEON_TIER_BY_ID.get(d.tier)!.order;
    for (const earlier of DUNGEONS) {
      for (const later of DUNGEONS) {
        if (orderOf(later) > orderOf(earlier)) {
          expect(later.difficultyTarget).toBeGreaterThanOrEqual(earlier.difficultyTarget);
          expect(later.dropItemLevel).toBeGreaterThanOrEqual(earlier.dropItemLevel);
        }
      }
    }
  });
});
