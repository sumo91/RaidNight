import { describe, expect, it } from 'vitest';
import { AURA_BY_CLASS } from '../content/comp';
import { CLASS_BY_ID } from '../content/classes';
import { DUNGEONS, DUNGEON_BY_ID, DUNGEON_SETTLEMENT, type DungeonDef } from '../content/dungeons';
import { GEAR_SLOTS, QUALITY_RULES, type Quality } from '../content/gear';
import { GAME_MINUTES_PER_DAY } from './clock';
import { SimulationFacade, step } from './facade';
import {
  bestWearer,
  dungeonStatuses,
  equipItem,
  rollDrops,
  settleDungeonDay,
  squadDungeon,
  squadDungeonReadiness,
  type DroppedItem,
} from './dungeon';
import { assessEncounter, rollEncounterOutcome } from './encounter';
import { averageItemLevel } from './roster';
import { nextFloat } from './rng';
import type { GameState, GearItem, Member, Squad } from './state';

/**
 * T6 门面测试:5 人本结算 —— 统一结算引擎 + 掉落 + 结果卡。
 * 与全项目一致只打门面接缝:驱动 SimulationFacade / 纯函数 step 断言状态快照与事件日志;
 * settleDungeonDay / rollDrops / bestWearer 为 sim 纯函数,按 T2-T5 先例直接断言。
 * 数值断言全部用内容常量独立重算(不复用结算实现的代码路径)。
 */

const SEED = 20261018;
const DUNGEON = DUNGEON_BY_ID.get('echo-catacomb') as DungeonDef;

/** 合成团员:只填下本结算涉及的维度(职业/专精给职能与光环,装备给战力)。 */
function synthMember(
  id: number,
  classId: string,
  specId: string,
  itemLevel: number,
  options?: { level?: number; fatigue?: number; name?: string },
): Member {
  return {
    id,
    isChairman: false,
    name: options?.name ?? `合成团员${id}`,
    classId,
    specId,
    level: options?.level ?? 20, // 等级只影响解锁刻度;结算战力只看装等
    experience: 0,
    gear: GEAR_SLOTS.map((slot) => ({ slot, quality: '白' as const, itemLevel })) as GearItem[],
    mood: 80,
    loyalty: 80,
    fatigue: options?.fatigue ?? 0,
    attendance: { styleId: 'iron', baseRate: 95 },
    traits: [],
    skillTierId: 'skilled',
  };
}

/** 标准编成:1 坦(战士·铁壁)+ 1 奶(牧师·圣言)+ 3 输出(法师三系)。 */
function standardSquad(itemLevel: number, fatigue = 0): Member[] {
  return [
    synthMember(1, 'warrior', 'warrior-guard', itemLevel, { fatigue }),
    synthMember(2, 'priest', 'priest-light', itemLevel, { fatigue }),
    synthMember(3, 'mage', 'mage-arcane', itemLevel, { fatigue }),
    synthMember(4, 'mage', 'mage-flame', itemLevel, { fatigue }),
    synthMember(5, 'mage', 'mage-frost', itemLevel, { fatigue }),
  ];
}

/** 独立重算:标准编成的职能分与光环合计(只用内容常量,不走实现路径)。 */
const STANDARD_ROLE_SCORE =
  DUNGEON_SETTLEMENT.roleScore.perTank * 1 +
  DUNGEON_SETTLEMENT.roleScore.perHealer * 1 +
  DUNGEON_SETTLEMENT.roleScore.perDps * 3;
const STANDARD_AURA_PERCENT = ['warrior', 'priest', 'mage'].reduce(
  (sum, classId) => sum + (AURA_BY_CLASS.get(classId)?.percent ?? 0),
  0,
);

/** 独立重算:标准编成、整队同装等下的战力与三段式胜率。 */
function expectedPower(itemLevel: number): number {
  return (itemLevel + STANDARD_ROLE_SCORE) * (1 + STANDARD_AURA_PERCENT / 100);
}

function expectedChance(itemLevel: number): number {
  const lower = DUNGEON.difficultyTarget - DUNGEON_SETTLEMENT.failMargin;
  const upper = DUNGEON.difficultyTarget + DUNGEON_SETTLEMENT.winMargin;
  return Math.max(0, Math.min(1, (expectedPower(itemLevel) - lower) / (upper - lower)));
}

/** 以真实初始状态为底(种子决定随机链起点),替换名册与编成。 */
function squadState(
  seed: number,
  members: readonly Member[],
  squad: Squad,
  extra?: { lastDungeonRun?: GameState['lastDungeonRun'] },
): GameState {
  const base = new SimulationFacade(seed, '测试公会').state;
  const maxMemberId = members.reduce((max, m) => Math.max(max, m.id), 0);
  return {
    ...base,
    members,
    nextMemberId: maxMemberId + 1,
    squads: [squad],
    nextSquadId: Math.max(squad.id + 1, 1),
    lastDungeonRun: extra?.lastDungeonRun,
  };
}

/** 进驻副本的状态:前 5 人成军下本,余者待命(activity 直填,聚焦结算;指令路径另有专测)。 */
function dungeonReadyState(seed: number, members: readonly Member[]): GameState {
  const squadMembers = members.slice(0, 5);
  return squadState(
    seed,
    members,
    { id: 1, memberIds: squadMembers.map((m) => m.id), activity: { type: 'dungeon', dungeonId: DUNGEON.id } },
  );
}

function squadAverageItemLevel(state: GameState, memberIds: readonly number[]): number {
  const avg = memberIds
    .map((id) => state.members.find((m) => m.id === id))
    .filter((m): m is Member => m !== undefined)
    .reduce((sum, m) => sum + averageItemLevel(m), 0);
  return avg / memberIds.length;
}

const ALL_IN_SQUAD = [1, 2, 3, 4, 5];

describe('统一结算引擎:三段式成败(验收标准 2)', () => {
  it('低配必败:战力不足下界时胜率为 0,实战逐日全败', () => {
    const facade = new SimulationFacade(7, '测试公会', dungeonReadyState(7, standardSquad(5)));
    const output = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });

    expect(expectedChance(5)).toBe(0); // 独立重算:低配落在必败区间
    const runs = output.events.filter((e) => e.kind === '下本');
    expect(runs).toHaveLength(DUNGEON.runsPerDay); // 一个游戏日 = runsPerDay 次结算
    expect(runs.every((e) => e.text.includes('败退'))).toBe(true);
    expect(facade.state.lastDungeonRun?.success).toBe(false);
    expect(facade.state.lastDungeonRun?.band).toBe('必败');
    expect(facade.state.lastDungeonRun?.drops).toHaveLength(0);
    // 败退不掉落:装等原样
    expect(squadAverageItemLevel(facade.state, ALL_IN_SQUAD)).toBe(5);
  });

  it('超配必胜:战力越过上界时胜率为 1,实战逐日全胜', () => {
    const facade = new SimulationFacade(7, '测试公会', dungeonReadyState(7, standardSquad(30)));
    const output = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });

    expect(expectedChance(30)).toBe(1);
    const runs = output.events.filter((e) => e.text.includes('速通') || e.text.includes('败退'));
    expect(runs).toHaveLength(DUNGEON.runsPerDay);
    expect(runs.every((e) => e.text.includes('速通'))).toBe(true);
    expect(facade.state.lastDungeonRun?.success).toBe(true);
    expect(facade.state.lastDungeonRun?.band).toBe('必胜');
    // 全队装等 30 高于掉落区间:胜利也无人可提升 → 全部分解,装等不变
    expect(output.events.some((e) => e.text.includes('随手分解'))).toBe(true);
    expect(squadAverageItemLevel(facade.state, ALL_IN_SQUAD)).toBe(30);
  });

  it('中间呈线性概率:胜率随装等严格递增,且都落在开区间 (0,1)', () => {
    for (const itemLevel of [7, 9, 11]) {
      const chance = expectedChance(itemLevel);
      expect(chance).toBeGreaterThan(0);
      expect(chance).toBeLessThan(1);
    }
    expect(expectedChance(7)).toBeLessThan(expectedChance(9));
    expect(expectedChance(9)).toBeLessThan(expectedChance(11));
    // 门面结果卡里的评估与独立重算一致(取当日两次全败的种子:装备未被掉落抬升,战力稳定)
    const facade = new SimulationFacade(7, '测试公会', dungeonReadyState(7, standardSquad(9)));
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    const report = facade.state.lastDungeonRun;
    expect(report).toBeDefined();
    expect(report?.power).toBeCloseTo(expectedPower(9), 8);
    expect(report?.successChance).toBeCloseTo(expectedChance(9), 8);
    expect(report?.band).toBe('悬念');
  });

  it('掷点引擎:概率 0 恒败、概率 1 恒胜、中间概率的长期频率贴近设定值', () => {
    let rng = 4242;
    let hits = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const [won, next] = rollEncounterOutcome(rng, 0.3);
      rng = next;
      if (won) {
        hits += 1;
      }
    }
    expect(hits / N).toBeGreaterThan(0.25);
    expect(hits / N).toBeLessThan(0.35);
    for (let i = 0; i < 100; i++) {
      expect(rollEncounterOutcome(rng, 0)[0]).toBe(false);
      const [, next] = nextFloat(rng);
      rng = next;
      expect(rollEncounterOutcome(rng, 1)[0]).toBe(true);
      rng = nextFloat(rng)[1];
    }
  });

  it('职能与光环共同计入战力:输出编成 > 坦奶冗余;光环越全战力越高', () => {
    // 同装等(16)下:1 坦 1 奶 3 输出(职能分 21)> 2 坦 2 奶 1 输出(职能分 17)
    const standard = assessEncounter(
      {
        averageItemLevel: 16,
        roleCounts: { 坦克: 1, 治疗: 1, 输出: 3 },
        auraBonusPercent: 0,
      },
      DUNGEON.difficultyTarget,
    );
    const tanky = assessEncounter(
      {
        averageItemLevel: 16,
        roleCounts: { 坦克: 2, 治疗: 2, 输出: 1 },
        auraBonusPercent: 0,
      },
      DUNGEON.difficultyTarget,
    );
    expect(standard.power).toBeGreaterThan(tanky.power);
    expect(standard.successChance).toBeGreaterThan(tanky.successChance);
    // 光环把战力整体放大:同结构下光环合计越高,胜率越高
    const withAura = assessEncounter(
      {
        averageItemLevel: 16,
        roleCounts: { 坦克: 1, 治疗: 1, 输出: 3 },
        auraBonusPercent: STANDARD_AURA_PERCENT,
      },
      DUNGEON.difficultyTarget,
    );
    expect(withAura.power).toBeCloseTo(standard.power * (1 + STANDARD_AURA_PERCENT / 100), 8);
    expect(withAura.successChance).toBeGreaterThan(standard.successChance);
  });

  it('多种子实测:悬念区间内实测胜率贴近评估胜率,且随装等单调上升', () => {
    const winRate = (itemLevel: number): number => {
      let wins = 0;
      let runs = 0;
      for (let seed = 1; seed <= 80; seed++) {
        const facade = new SimulationFacade(seed, '测试公会', dungeonReadyState(seed, standardSquad(itemLevel)));
        const output = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
        for (const event of output.events) {
          if (event.kind === '下本' && (event.text.includes('速通') || event.text.includes('败退'))) {
            runs += 1;
            if (event.text.includes('速通')) {
              wins += 1;
            }
          }
        }
      }
      expect(runs).toBe(80 * DUNGEON.runsPerDay);
      return wins / runs;
    };

    const low = winRate(7);
    const mid = winRate(9);
    const high = winRate(11);
    // 独立重算的评估值落在中段;实测与评估同侧且严格单调(分布成立)
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(Math.abs(mid - expectedChance(9))).toBeLessThan(0.12);
  });
});

describe('进本门槛:派满职能小队进入首个 5 人本(验收标准 1)', () => {
  function facadeWith(members: readonly Member[], squad?: Squad): SimulationFacade {
    const squadDef = squad ?? { id: 1, memberIds: members.map((m) => m.id) };
    return new SimulationFacade(SEED, '测试公会', squadState(SEED, members, squadDef));
  }

  it('满职能小队可进驻;重复指派无事件、无变化', () => {
    const facade = facadeWith(standardSquad(13));
    const assigned = facade.dispatch({
      command: { type: 'assignDungeon', squadId: 1, dungeonId: DUNGEON.id },
      deltaGameMinutes: 0,
    });
    expect(assigned.events).toHaveLength(1);
    expect(assigned.events[0]?.kind).toBe('下本');
    expect(assigned.events[0]?.text).toContain('进驻「回声墓道」');
    expect(facade.state.squads[0]?.activity).toEqual({ type: 'dungeon', dungeonId: DUNGEON.id });

    const again = facade.dispatch({
      command: { type: 'assignDungeon', squadId: 1, dungeonId: DUNGEON.id },
      deltaGameMinutes: 0,
    });
    expect(again.events).toEqual([]);
  });

  it('未满员 / 缺坦克 / 缺治疗的小队被门面拒绝(状态与日志均无变化)', () => {
    const cases: readonly { label: string; members: readonly Member[] }[] = [
      {
        label: '未满员',
        members: standardSquad(13).slice(0, 4),
      },
      {
        label: '缺坦克',
        members: [
          synthMember(1, 'priest', 'priest-light', 13),
          synthMember(2, 'mage', 'mage-arcane', 13),
          synthMember(3, 'mage', 'mage-flame', 13),
          synthMember(4, 'mage', 'mage-frost', 13),
          synthMember(5, 'rogue', 'rogue-venom', 13),
        ],
      },
      {
        label: '缺治疗',
        members: [
          synthMember(1, 'warrior', 'warrior-guard', 13),
          synthMember(2, 'mage', 'mage-arcane', 13),
          synthMember(3, 'mage', 'mage-flame', 13),
          synthMember(4, 'mage', 'mage-frost', 13),
          synthMember(5, 'rogue', 'rogue-venom', 13),
        ],
      },
    ];
    for (const { members } of cases) {
      const facade = facadeWith(members);
      const before = structuredClone(facade.state);
      const output = facade.dispatch({
        command: { type: 'assignDungeon', squadId: 1, dungeonId: DUNGEON.id },
        deltaGameMinutes: 0,
      });
      expect(output.events).toEqual([]);
      expect(facade.state.squads[0]?.activity).toBeUndefined();
      expect(facade.state).toEqual(before);
      // 就绪判定的缺口标示与拒绝原因一致(UI 展示同一派生量)
      const readiness = squadDungeonReadiness(facade.state.squads[0]!, facade.state.members);
      expect(readiness.ready).toBe(false);
      expect(readiness.reasons.length).toBeGreaterThan(0);
    }
  });

  it('未解锁的副本被拒绝;解锁刻度随公会平均等级变化', () => {
    const lowLevel = standardSquad(13).map((m) => ({ ...m, level: 5 })); // 公会平均 5 < 10
    expect(dungeonStatuses(lowLevel)[0]?.unlocked).toBe(false);
    const facade = facadeWith(lowLevel);
    const output = facade.dispatch({
      command: { type: 'assignDungeon', squadId: 1, dungeonId: DUNGEON.id },
      deltaGameMinutes: 0,
    });
    expect(output.events).toEqual([]);
    expect(facade.state.squads[0]?.activity).toBeUndefined();

    expect(dungeonStatuses(standardSquad(13))[0]?.unlocked).toBe(true); // 平均 20 ≥ 10
  });

  it('下本替换练级安排;停止下本清空安排并可再次休整', () => {
    const facade = facadeWith(standardSquad(13));
    facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId: 'windmill-plains' }, deltaGameMinutes: 0 });
    expect(facade.state.squads[0]?.activity).toEqual({ type: 'leveling', mapId: 'windmill-plains' });

    facade.dispatch({ command: { type: 'assignDungeon', squadId: 1, dungeonId: DUNGEON.id }, deltaGameMinutes: 0 });
    expect(facade.state.squads[0]?.activity).toEqual({ type: 'dungeon', dungeonId: DUNGEON.id });

    const stopped = facade.dispatch({ command: { type: 'stopDungeon', squadId: 1 }, deltaGameMinutes: 0 });
    expect(stopped.events.map((e) => e.kind)).toEqual(['下本']);
    expect(facade.state.squads[0]?.activity).toBeUndefined();
    // 本就没有下本安排时再次停止:忽略
    const again = facade.dispatch({ command: { type: 'stopDungeon', squadId: 1 }, deltaGameMinutes: 0 });
    expect(again.events).toEqual([]);
  });
});

describe('掉落生成与自动择优穿戴(验收标准 3)', () => {
  it('掉落生成确定性:同一随机链产出逐字节一致', () => {
    const [a] = rollDrops(1234567, DUNGEON, 8);
    const [b] = rollDrops(1234567, DUNGEON, 8);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('掉落形如「8 部位 × 4 品质」,装等 = 基准 + 品质加成 ± 扰动', () => {
    let rng = 999;
    for (let i = 0; i < 600; i++) {
      const [items, next] = rollDrops(rng, DUNGEON, 1);
      rng = next;
      const item = items[0] as DroppedItem;
      expect(GEAR_SLOTS).toContain(item.slot);
      expect(['白', '绿', '蓝', '紫']).toContain(item.quality);
      const bonus = QUALITY_RULES.find((r) => r.quality === item.quality)?.itemLevelBonus ?? 0;
      expect(item.itemLevel).toBe(DUNGEON.dropItemLevel + bonus + (item.itemLevel - DUNGEON.dropItemLevel - bonus));
      expect(item.itemLevel).toBeGreaterThanOrEqual(DUNGEON.dropItemLevel + bonus - DUNGEON_SETTLEMENT.dropJitter);
      expect(item.itemLevel).toBeLessThanOrEqual(DUNGEON.dropItemLevel + bonus + DUNGEON_SETTLEMENT.dropJitter);
      expect(item.itemLevel).toBeGreaterThanOrEqual(1);
    }
  });

  it('品质分布合理:长期频率贴近内容表权重(绿 > 白 ≈ 蓝 > 紫)', () => {
    let rng = 2026;
    const counts: Record<Quality, number> = { 白: 0, 绿: 0, 蓝: 0, 紫: 0 };
    const N = 2400;
    for (let i = 0; i < N; i++) {
      const [items, next] = rollDrops(rng, DUNGEON, 1);
      rng = next;
      counts[(items[0] as DroppedItem).quality] += 1;
    }
    const rate = (q: Quality) => counts[q] / N;
    const totalWeight = 25 + 45 + 25 + 5;
    expect(rate('绿')).toBeGreaterThan(0.4); // 权重 45/100
    expect(Math.abs(rate('白') - 25 / totalWeight)).toBeLessThan(0.06);
    expect(Math.abs(rate('蓝') - 25 / totalWeight)).toBeLessThan(0.06);
    expect(rate('紫')).toBeLessThan(0.09); // 稀有档明显最少
    expect(rate('绿')).toBeGreaterThan(rate('紫'));
    expect(rate('蓝')).toBeGreaterThan(rate('紫'));
  });

  it('择优穿戴:掉落归该部位提升最大的队员;并列取队首;换装不可变', () => {
    const lowWrist = synthMember(1, 'warrior', 'warrior-guard', 5);
    const midWrist = synthMember(2, 'priest', 'priest-light', 12);
    const drop: DroppedItem = { slot: '腕', quality: '蓝', itemLevel: 19 };
    const best = bestWearer([midWrist, lowWrist], drop);
    expect(best.member.id).toBe(1); // +14 优于 +7
    expect(best.delta).toBe(14);

    const tie = bestWearer(
      [lowWrist, { ...midWrist, gear: lowWrist.gear }],
      drop,
    );
    expect(tie.member.id).toBe(1); // 并列取编入顺序靠前者

    const before = structuredClone(lowWrist);
    const equipped = equipItem(lowWrist, drop);
    expect(equipped.gear.find((g) => g.slot === '腕')).toEqual({ slot: '腕', quality: '蓝', itemLevel: 19 });
    expect(lowWrist).toEqual(before); // 不可变:原团员未被改动
    expect(equipped.gear).toHaveLength(lowWrist.gear.length); // 8 部位原位替换
  });

  it('胜利结算自动穿戴:小队装等只升不降,去向全是队内提升', () => {
    const facade = new SimulationFacade(3, '测试公会', dungeonReadyState(3, standardSquad(13)));
    const before = squadAverageItemLevel(facade.state, ALL_IN_SQUAD);
    const output = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY * 3 });
    const wins = output.events.filter((e) => e.kind === '下本' && e.text.includes('速通')).length;
    const after = squadAverageItemLevel(facade.state, ALL_IN_SQUAD);
    expect(after).toBeGreaterThanOrEqual(before);
    if (wins > 0) {
      expect(after).toBeGreaterThan(before); // 有胜局 ⇒ 择优穿戴提升了装等
    }
    // 装备只在 8 部位内原位替换,品质合法
    for (const id of ALL_IN_SQUAD) {
      const member = facade.state.members.find((m) => m.id === id) as Member;
      expect(member.gear).toHaveLength(GEAR_SLOTS.length);
      for (const piece of member.gear) {
        expect(GEAR_SLOTS).toContain(piece.slot);
      }
    }
  });
});

describe('逐日结算:结果卡 + 短日志(验收标准 4 与验收标准 5)', () => {
  it('一个游戏日按 runsPerDay 次结算,短日志顺序 = 结果行在前、掉落去向在后', () => {
    const facade = new SimulationFacade(7, '测试公会', dungeonReadyState(7, standardSquad(30)));
    const output = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    const lines = output.events.filter((e) => e.kind === '下本').map((e) => e.text);

    expect(lines).toHaveLength(DUNGEON.runsPerDay * (1 + DUNGEON.dropsPerRun));
    for (let run = 0; run < DUNGEON.runsPerDay; run++) {
      const outcome = lines[run * (1 + DUNGEON.dropsPerRun)] as string;
      expect(outcome).toContain('速通');
      expect(outcome).toContain(`战力 ${Math.round(expectedPower(30))} 对难度 ${DUNGEON.difficultyTarget}`);
      expect(outcome).toContain('胜率 100%');
      for (let drop = 1; drop <= DUNGEON.dropsPerRun; drop++) {
        expect(lines[run * (1 + DUNGEON.dropsPerRun) + drop]).toContain('掉落:');
      }
    }
    // 事件序号仍全局连续;下本结算发生在日界(与日更同刻)
    const seqs = output.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(output.events.map((e) => e.atGameMinutes)).size).toBe(1);
  });

  it('结果卡数据完整:三要素快照、参战名单、掉落去向', () => {
    // 种子 7:当日两次全败 ⇒ 装备未被掉落抬升,快照数值稳定可比
    const facade = new SimulationFacade(7, '测试公会', dungeonReadyState(7, standardSquad(9)));
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    const report = facade.state.lastDungeonRun;
    expect(report).toBeDefined();
    expect(report?.dungeonId).toBe(DUNGEON.id);
    expect(report?.dungeonName).toBe(DUNGEON.name);
    expect(report?.squadId).toBe(1);
    expect(report?.squadOrdinal).toBe(1);
    expect(report?.atGameMinutes).toBe(GAME_MINUTES_PER_DAY);
    expect(report?.target).toBe(DUNGEON.difficultyTarget);
    expect(report?.power).toBeCloseTo(expectedPower(9), 8);
    expect(report?.members).toHaveLength(5);
    // 参战名单:名字/职能/装等快照(职能查自职业表,独立重算)
    const roles = report?.members.map((m) => m.role);
    expect(roles?.filter((r) => r === '坦克')).toHaveLength(1);
    expect(roles?.filter((r) => r === '治疗')).toHaveLength(1);
    expect(roles?.filter((r) => r === '输出')).toHaveLength(3);
    for (const member of report?.members ?? []) {
      expect(member.itemLevel).toBe(9);
      expect(member.name).toMatch(/^合成团员\d$/);
    }
    // 掉落去向:要么穿上(正提升 + 队内姓名),要么明确分解
    for (const drop of report?.drops ?? []) {
      if (drop.equipped) {
        expect(drop.upgradeDelta).toBeGreaterThan(0);
        expect(report?.members.some((m) => m.name === drop.assignedTo)).toBe(true);
      } else {
        expect(drop.assignedTo).toBeUndefined();
      }
    }
    expect(CLASS_BY_ID.size).toBe(9); // 内容表就位(9 职业)
  });

  it('疲劳结算:下本队员每次 +fatiguePerRun 且不再休整恢复;队外团员照常休整', () => {
    const members = [
      ...standardSquad(13, 50),
      synthMember(6, 'rogue', 'rogue-venom', 13, { fatigue: 50 }), // 队外待命
    ];
    const facade = new SimulationFacade(9, '测试公会', dungeonReadyState(9, members));
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });

    for (const id of ALL_IN_SQUAD) {
      const member = facade.state.members.find((m) => m.id === id) as Member;
      // 50(起步)+ 6×2(下本两次)—— 下本小队不享受休整恢复
      expect(member.fatigue).toBe(50 + DUNGEON.fatiguePerRun * DUNGEON.runsPerDay);
    }
    const bench = facade.state.members.find((m) => m.id === 6) as Member;
    expect(bench.fatigue).toBe(50 - 15); // 待命休整:每日 −15(练级配置)
  });

  it('疲劳封顶不超过上限;人手不齐时暂停下本、不消费随机链', () => {
    const capped = standardSquad(30).map((m, i) =>
      i === 0 ? { ...m, fatigue: 97 } : m,
    );
    const facade = new SimulationFacade(9, '测试公会', dungeonReadyState(9, capped));
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect((facade.state.members.find((m) => m.id === 1) as Member).fatigue).toBe(100);

    // 直接驱动纯函数:4 人小队(缺 1 人)→ 暂停且随机链不动
    const shortSquad: Squad = {
      id: 1,
      memberIds: [1, 2, 3, 4],
      activity: { type: 'dungeon', dungeonId: DUNGEON.id },
    };
    const lines: string[] = [];
    const paused = settleDungeonDay({
      members: capped,
      squads: [shortSquad],
      rngState: 555,
      atGameMinutes: GAME_MINUTES_PER_DAY,
      emit: (text) => lines.push(text),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('暂停');
    expect(lines[0]).toContain('未满员');
    expect(paused.rngState).toBe(555); // 未掷点
    expect(paused.members).toEqual(capped); // 未损耗
    expect(paused.lastReport).toBeUndefined();
  });

  it('淘汰导致人手不齐:门面逐日给出暂停日志,无战报更新', () => {
    const facade = new SimulationFacade(13, '测试公会', dungeonReadyState(13, standardSquad(30)));
    facade.dispatch({ command: { type: 'dismissMember', memberId: 5 }, deltaGameMinutes: 0 });
    const output = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    const lines = output.events.filter((e) => e.kind === '下本').map((e) => e.text);
    expect(lines).toEqual([`第 1 小队下本暂停:未满员,补齐编成后自动恢复。`]);
    expect(facade.state.lastDungeonRun).toBeUndefined();
  });

  it('内容表裁撤的旧副本 id 视同休整(防御,不炸模拟)', () => {
    const squad: Squad = { id: 1, memberIds: ALL_IN_SQUAD, activity: { type: 'dungeon', dungeonId: 'nope' } };
    expect(squadDungeon(squad)).toBeUndefined();
    const lines: string[] = [];
    const result = settleDungeonDay({
      members: standardSquad(13),
      squads: [squad],
      rngState: 77,
      atGameMinutes: 0,
      emit: (text) => lines.push(text),
    });
    expect(lines).toEqual([]);
    expect(result.lastReport).toBeUndefined();
  });

  it('固定种子重放:指令与时间序列相同 ⇒ 状态与日志逐字节一致(验收标准 5)', () => {
    const run = (): { state: GameState; texts: string[] } => {
      const facade = new SimulationFacade(SEED, '测试公会', squadState(SEED, standardSquad(13), { id: 1, memberIds: ALL_IN_SQUAD }));
      facade.dispatch({ command: { type: 'assignDungeon', squadId: 1, dungeonId: DUNGEON.id }, deltaGameMinutes: 0 });
      const output = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY * 4 });
      return { state: facade.state, texts: output.events.map((e) => e.text) };
    };
    const first = run();
    const second = run();
    expect(second.state).toEqual(first.state);
    expect(second.texts).toEqual(first.texts);
    expect(JSON.stringify(second.state)).toBe(JSON.stringify(first.state));
    expect(JSON.stringify(second.texts)).toBe(JSON.stringify(first.texts));
    expect(first.state.lastDungeonRun).toBeDefined();
  });

  it('纯函数 step 不原地修改输入状态', () => {
    const facade = new SimulationFacade(17, '测试公会', dungeonReadyState(17, standardSquad(13)));
    const before = structuredClone(facade.state);
    const output = step(facade.state, { deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(facade.state).toEqual(before);
    expect(output.state).not.toBe(facade.state);
    const again = step(facade.state, { deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(again).toEqual(output);
  });
});

describe('内容表就位(数据驱动)', () => {
  it('表首为普通档「回声墓道」,数值配置完整;首批内容覆盖四档(阶梯结构见 ladder.test.ts)', () => {
    expect(DUNGEONS[0]?.id).toBe('echo-catacomb');
    expect(DUNGEON.tier).toBe('普通');
    expect(DUNGEON.unlock.averageLevel).toBe(10);
    expect(DUNGEON.unlock.averageItemLevel).toBeGreaterThanOrEqual(0);
    expect(DUNGEON.runsPerDay).toBeGreaterThan(0);
    expect(DUNGEON.dropsPerRun).toBeGreaterThan(0);
    expect(DUNGEON.dropItemLevel).toBeGreaterThan(0);
    expect(DUNGEON.difficultyTarget).toBeGreaterThan(0);
    // 必败下界严格低于必胜上界:三段式区间成立
    expect(DUNGEON.difficultyTarget - DUNGEON_SETTLEMENT.failMargin).toBeLessThan(
      DUNGEON.difficultyTarget + DUNGEON_SETTLEMENT.winMargin,
    );
  });
});
