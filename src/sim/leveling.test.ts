import { describe, expect, it } from 'vitest';
import { LEVELING, LEVELING_MAPS, LEVELING_MAP_BY_ID, type LevelingMapDef } from '../content/maps';
import { GAME_MINUTES_PER_DAY, GAME_MINUTES_PER_WEEK } from './clock';
import { SimulationFacade, step } from './facade';
import { levelingMapStatuses, settleLevelingDay, squadLevelingMap, xpToNextLevel } from './leveling';
import { guildAverageLevel } from './roster';
import type { GameState, Member, Squad } from './state';

/**
 * T5 门面测试:练级活动 —— 地图分配 + 自动成长。
 * 与全项目一致只打门面接缝:构造/驱动 SimulationFacade 或纯函数 step,
 * 断言状态快照与事件日志;settleLevelingDay / levelingMapStatuses 为 sim 纯函数,
 * 按 T2-T4 先例直接断言。数值断言全部用内容常量独立重算(不复用结算实现的代码路径)。
 */

const SEED = 20261018;

/** 合成团员:只填练级结算涉及的维度,其余取合法常量。 */
function synthMember(id: number, level: number, experience = 0, fatigue = 0): Member {
  return {
    id,
    isChairman: false,
    joinedAtGameMinutes: 0,
    benchDays: 0,
    name: `合成团员${id}`,
    classId: 'warrior',
    specId: 'warrior-guard',
    level,
    experience,
    gear: [],
    mood: 80,
    loyalty: 80,
    personalGold: 0,
    dkp: 0,
    fatigue,
    attendance: { styleId: 'iron', baseRate: 95 },
    traits: [],
    skillTierId: 'skilled',
    bossKills: 0,
    rareLootWon: 0,
  };
}

/** 以真实初始状态为底,替换名册与编成(其余字段保持合法)。 */
function stateWith(members: readonly Member[], squads: readonly Squad[]): GameState {
  const base = new SimulationFacade(1, '测试公会').state;
  const maxMemberId = members.reduce((max, m) => Math.max(max, m.id), 0);
  const maxSquadId = squads.reduce((max, s) => Math.max(max, s.id), 0);
  return {
    ...base,
    members,
    nextMemberId: maxMemberId + 1,
    squads,
    nextSquadId: maxSquadId + 1,
  };
}

/** 内容曲线的独立重算:升级所需经验(不经 xpToNextLevel 的实现路径)。 */
function requiredXp(level: number): number {
  return LEVELING.xpCurve.perLevel * level + LEVELING.xpCurve.perLevelSquared * level * level;
}

/** 一名团员练级一日的独立重算(阵亡与否由疲劳增量反推;只用内容常量)。 */
function expectedAfterLevelingDay(member: Member, map: LevelingMapDef, died: boolean): Member {
  const efficiency = Math.max(LEVELING.minEfficiency, 1 - member.fatigue * LEVELING.efficiencyLossPerFatigue);
  const gained =
    Math.floor(map.xpPerDay * efficiency) -
    (died ? Math.floor((map.xpPerDay * LEVELING.death.xpLossPercent) / 100) : 0);
  let experience = Math.max(0, member.experience + gained);
  let level = member.level;
  while (level < LEVELING.maxLevel) {
    const required = requiredXp(level);
    if (experience < required) {
      break;
    }
    experience -= required;
    level += 1;
  }
  if (level >= LEVELING.maxLevel) {
    experience = 0;
  }
  return {
    ...member,
    experience,
    level,
    fatigue: Math.min(
      LEVELING.maxFatigue,
      member.fatigue + map.fatiguePerDay + (died ? LEVELING.death.fatiguePenalty : 0),
    ),
  };
}

/** 建队并把名册前 5 人编入(名册 6 人,留 1 人在队外作休整对照)。 */
function setupLevelingSquad(seed: number): SimulationFacade {
  const facade = new SimulationFacade(seed, '星盾公会');
  facade.dispatch({ command: { type: 'createSquad' }, deltaGameMinutes: 0 });
  for (const member of facade.state.members.slice(0, 5)) {
    facade.dispatch({ command: { type: 'assignToSquad', memberId: member.id, squadId: 1 }, deltaGameMinutes: 0 });
  }
  return facade;
}

describe('地图内容表:两档风险(验收标准 1 的数据面)', () => {
  it('同阶段两档成对解锁,高效区经验更多、疲劳与阵亡损耗更重', () => {
    // 按等级带下限(解锁门槛)分阶段;每阶段恰有高效/休闲各一张
    const byUnlock = new Map<number, LevelingMapDef[]>();
    for (const def of LEVELING_MAPS) {
      const stage = byUnlock.get(def.levelBand.min) ?? [];
      stage.push(def);
      byUnlock.set(def.levelBand.min, stage);
    }
    expect(byUnlock.size).toBeGreaterThanOrEqual(3); // 首批 3 阶段
    for (const stage of byUnlock.values()) {
      const intensive = stage.find((m) => m.tier === '高效');
      const relaxed = stage.find((m) => m.tier === '休闲');
      expect(intensive).toBeDefined();
      expect(relaxed).toBeDefined();
      expect(intensive!.xpPerDay).toBeGreaterThan(relaxed!.xpPerDay * 2); // 经验显著更多
      expect(intensive!.fatiguePerDay).toBeGreaterThan(relaxed!.fatiguePerDay); // 疲劳更重
      expect(intensive!.deathChancePerDay).toBeGreaterThan(relaxed!.deathChancePerDay); // 阵亡更频
    }
  });

  it('地图按等级带下限升序排列,id 唯一;经验曲线随等级单调上升', () => {
    const unlocks = LEVELING_MAPS.map((m) => m.levelBand.min);
    expect([...unlocks].sort((a, b) => a - b)).toEqual(unlocks);
    expect(new Set(LEVELING_MAPS.map((m) => m.id)).size).toBe(LEVELING_MAPS.length);
    for (const def of LEVELING_MAPS) {
      expect(LEVELING_MAP_BY_ID.get(def.id)).toBe(def);
      expect(def.xpPerDay).toBeGreaterThan(0);
    }
    for (let level = 2; level < LEVELING.maxLevel; level++) {
      expect(xpToNextLevel(level)).toBeGreaterThan(xpToNextLevel(level - 1));
      expect(xpToNextLevel(level)).toBe(requiredXp(level)); // 实现公式 = 内容曲线
    }
  });
});

describe('公会平均等级与地图解锁(验收标准 1)', () => {
  it('guildAverageLevel = 全员等级均值向下取整(空名册为 0)', () => {
    expect(guildAverageLevel([])).toBe(0);
    expect(guildAverageLevel([synthMember(1, 10), synthMember(2, 11), synthMember(3, 12)])).toBe(11);
    expect(guildAverageLevel([synthMember(1, 12), synthMember(2, 8), synthMember(3, 9), synthMember(4, 10)])).toBe(9);
  });

  it('建会即解锁首批两张(unlock 1):风磨草原与采石场营地,后续阶段锁定', () => {
    const state = new SimulationFacade(SEED, '星盾公会').state;
    const statuses = levelingMapStatuses(state.members);
    expect(statuses.filter((s) => s.unlocked).map((s) => s.def.id).sort()).toEqual(
      ['quarry-camp', 'windmill-plains'],
    );
    for (const status of statuses) {
      expect(status.unlocked).toBe(guildAverageLevel(state.members) >= status.def.levelBand.min);
    }
    expect(guildAverageLevel(state.members)).toBeGreaterThanOrEqual(8); // 建会均值约 9-11
  });

  it('练级成长抬高平均等级:跨过 14 后第 2 阶段两张地图解锁', () => {
    const facade = setupLevelingSquad(SEED);
    facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId: 'quarry-camp' }, deltaGameMinutes: 0 });
    expect(levelingMapStatuses(facade.state.members).filter((s) => s.unlocked)).toHaveLength(2);

    // 逐日推进直到第 2 阶段解锁(高效区日入数级经验,数日内即跨 14)
    let days = 0;
    while (
      levelingMapStatuses(facade.state.members).filter((s) => s.unlocked).length < 4 &&
      days < 21
    ) {
      facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
      days += 1;
    }
    expect(days).toBeLessThan(21); // 真实成长把平均等级推过了门槛
    expect(guildAverageLevel(facade.state.members)).toBeGreaterThanOrEqual(14);

    // 解锁后:第 2 阶段的休闲区也可进驻(此前会被门面拒绝,见下一组用例)
    const assigned = facade.dispatch({
      command: { type: 'assignLevelingMap', squadId: 1, mapId: 'mistmarsh' },
      deltaGameMinutes: 0,
    });
    expect(assigned.events.map((e) => e.text)).toEqual(['第 1 小队进驻「雾沼」(休闲区)练级。']);
  });
});

describe('练级指令:经门面裁决(验收标准 1 与 4 的状态面)', () => {
  it('进驻已解锁地图:活动写入小队,记「练级」事件', () => {
    const facade = setupLevelingSquad(SEED);
    const output = facade.dispatch({
      command: { type: 'assignLevelingMap', squadId: 1, mapId: 'quarry-camp' },
      deltaGameMinutes: 0,
    });
    expect(output.state.squads[0]).toEqual({
      id: 1,
      memberIds: [1, 2, 3, 4, 5],
      activity: { type: 'leveling', mapId: 'quarry-camp' },
    });
    expect(output.events.map((e) => [e.kind, e.text])).toEqual([
      ['练级', '第 1 小队进驻「采石场营地」(高效区)练级。'],
    ]);
    expect(squadLevelingMap(output.state.squads[0]!)?.id).toBe('quarry-camp');
  });

  it('未解锁地图被忽略:状态不变、无事件(可选范围 = 已解锁地图)', () => {
    const facade = setupLevelingSquad(SEED);
    const before = structuredClone(facade.state);
    const blocked = facade.dispatch({
      command: { type: 'assignLevelingMap', squadId: 1, mapId: 'mistmarsh' }, // 需平均等级 14
      deltaGameMinutes: 0,
    });
    expect(blocked.events).toEqual([]);
    expect(facade.state).toEqual(before);
  });

  it('未知地图 / 未知小队 / 重复进驻同图:一律忽略', () => {
    const facade = setupLevelingSquad(SEED);
    facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId: 'windmill-plains' }, deltaGameMinutes: 0 });
    const before = structuredClone(facade.state);

    expect(facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId: 'no-such-map' }, deltaGameMinutes: 0 }).events).toEqual([]);
    expect(facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 999, mapId: 'windmill-plains' }, deltaGameMinutes: 0 }).events).toEqual([]);
    expect(facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId: 'windmill-plains' }, deltaGameMinutes: 0 }).events).toEqual([]); // 已在该图
    expect(facade.dispatch({ command: { type: 'stopLeveling', squadId: 999 }, deltaGameMinutes: 0 }).events).toEqual([]);
    expect(facade.state).toEqual(before);
  });

  it('换图与停止:活动替换/清除,事件文案对应', () => {
    const facade = setupLevelingSquad(SEED);
    facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId: 'windmill-plains' }, deltaGameMinutes: 0 });

    const switched = facade.dispatch({
      command: { type: 'assignLevelingMap', squadId: 1, mapId: 'quarry-camp' },
      deltaGameMinutes: 0,
    });
    expect(switched.state.squads[0]!.activity).toEqual({ type: 'leveling', mapId: 'quarry-camp' });
    expect(switched.events.map((e) => e.text)).toEqual(['第 1 小队进驻「采石场营地」(高效区)练级。']);

    const stopped = facade.dispatch({ command: { type: 'stopLeveling', squadId: 1 }, deltaGameMinutes: 0 });
    expect(stopped.state.squads[0]!.activity).toBeUndefined();
    expect(stopped.events.map((e) => e.text)).toEqual(['第 1 小队结束练级,回城休整。']);

    // 本就休整的队再停:忽略
    expect(facade.dispatch({ command: { type: 'stopLeveling', squadId: 1 }, deltaGameMinutes: 0 }).events).toEqual([]);
  });

  it('解散小队即撤销其练级安排;淘汰队员不中断其余队员的练级', () => {
    const facade = setupLevelingSquad(SEED);
    facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId: 'quarry-camp' }, deltaGameMinutes: 0 });

    const dismissed = facade.dispatch({ command: { type: 'dismissMember', memberId: 5 }, deltaGameMinutes: 0 });
    expect(dismissed.state.squads[0]!.memberIds).toEqual([1, 2, 3, 4]);
    expect(dismissed.state.squads[0]!.activity).toEqual({ type: 'leveling', mapId: 'quarry-camp' }); // 安排保留

    // 全员调离后解散空队:活动随小队一起消失
    for (const id of [1, 2, 3, 4]) {
      facade.dispatch({ command: { type: 'removeFromSquad', memberId: id }, deltaGameMinutes: 0 });
    }
    const disbanded = facade.dispatch({ command: { type: 'disbandSquad', squadId: 1 }, deltaGameMinutes: 0 });
    expect(disbanded.state.squads).toEqual([]);
  });
});

describe('一日结算:固定时间跳变的成长与疲劳数值(验收标准 2 与 4)', () => {
  it('进驻高效区跨一个日界:经验/等级/疲劳与内容常量独立重算逐人一致', () => {
    const facade = setupLevelingSquad(SEED);
    const before = structuredClone(facade.state.members);
    facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId: 'quarry-camp' }, deltaGameMinutes: 0 });

    const output = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY }); // 恰跨第 2 日日界
    expect(output.events.every((e) => e.kind !== '练级')).toBe(true); // 练级静默计数:结算不产生事件

    const map = LEVELING_MAP_BY_ID.get('quarry-camp')!;
    for (const old of before) {
      const after = output.state.members.find((m) => m.id === old.id)!;
      if (old.id <= 5) {
        // 队内 5 人:疲劳增量 ∈ {16, 阵亡 16+6};据增量反推阵亡后独立重算
        const fatigueDelta = after.fatigue - old.fatigue;
        expect([map.fatiguePerDay, map.fatiguePerDay + LEVELING.death.fatiguePenalty]).toContain(fatigueDelta);
        const died = fatigueDelta > map.fatiguePerDay;
        expect(after).toEqual(expectedAfterLevelingDay(old, map, died));
      } else {
        // 队外 1 人:休整,仅疲劳下降;另有冷板凳计数 +1(T12,其余维度分毫不动)
        const { benchDays: afterBench, ...afterRest } = after;
        const { benchDays: oldBench, ...oldRest } = old;
        expect({ ...afterRest, fatigue: 0 }).toEqual({ ...oldRest, fatigue: 0 });
        expect(afterBench).toBe(oldBench + 1); // 公会已有小队:待命日数逐日累计
        expect(after.fatigue).toBe(Math.max(0, old.fatigue - LEVELING.restFatiguePerDay));
      }
    }
  });

  it('一日之内的推进不结算:成长只发生在跨日界的步', () => {
    const facade = setupLevelingSquad(SEED);
    facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId: 'quarry-camp' }, deltaGameMinutes: 0 });
    const before = structuredClone(facade.state.members);

    const within = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY - 1 }); // 日内
    expect(within.state.members).toEqual(before); // 无任何成长
    expect(within.state.members.every((m) => m.experience === 0)).toBe(true);

    const crossing = facade.dispatch({ deltaGameMinutes: 1 }); // 跨过日界
    expect(crossing.state.members).not.toEqual(before);
    const beforeById = new Map(before.map((m) => [m.id, m]));
    expect(
      crossing.state.members.some((m) => m.experience > 0 || m.level > beforeById.get(m.id)!.level),
    ).toBe(true);
  });

  it('满级:等级封顶、经验清零不再累计,疲劳照常积累', () => {
    // 59 级团员在灰烬矿道:首日不足以升级(20000 < 59 级需求),次日跨过 60 后经验清零
    const state = stateWith(
      [synthMember(1, 59), synthMember(2, 60)],
      [{ id: 1, memberIds: [1, 2], activity: { type: 'leveling', mapId: 'cinder-mine' } }],
    );
    const day1 = step(state, { deltaGameMinutes: GAME_MINUTES_PER_DAY });
    const m1 = day1.state.members[0]!;
    const m2 = day1.state.members[1]!;
    expect(m1.level).toBe(59); // 20000×效率 < 59 级需求
    expect(m1.experience).toBeGreaterThan(0);
    expect(m2.level).toBe(60); // 满级不超上限
    expect(m2.experience).toBe(0); // 满级经验恒为 0
    expect(m2.fatigue).toBeGreaterThan(0); // 疲劳照常积累

    const day2 = step(day1.state, { deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(day2.state.members[0]!.level).toBe(60); // 跨过上限
    expect(day2.state.members[0]!.experience).toBe(0); // 余数清零
    const day3 = step(day2.state, { deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(day3.state.members.every((m) => m.level === 60 && m.experience === 0)).toBe(true);
  });

  it('settleLevelingDay 纯函数:无练级安排不消费随机链;零疲劳休整原样返回', () => {
    const tired = [synthMember(1, 10, 0, 30), synthMember(2, 10, 0, 10)];
    const rested = settleLevelingDay(tired, [], 12345);
    expect(rested.rngState).toBe(12345); // 未掷任何阵亡判定
    expect(rested.members.map((m) => m.fatigue)).toEqual([15, 0]); // 30-15、10-15→0

    const idleInput = [synthMember(1, 10)]; // 零疲劳:休整无事可做
    const idle = settleLevelingDay(idleInput, [], 999);
    expect(idle.members).toBe(idleInput); // 原数组原样返回(不重建)
  });
});

describe('两档风险的结果差异(验收标准 3)', () => {
  /** 同种子双门面,同编成,分别进驻两档地图,逐日推进一周并统计可观察的阵亡次数。 */
  function runWeek(mapId: string) {
    const facade = setupLevelingSquad(SEED);
    facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId }, deltaGameMinutes: 0 });
    const map = LEVELING_MAP_BY_ID.get(mapId)!;
    let prev = structuredClone(facade.state.members); // 推进前的名册(首日基准)
    let deaths = 0;
    for (let day = 0; day < 7; day++) {
      const output = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
      for (const member of output.state.members) {
        if (member.id > 5) {
          continue; // 只看练级队的 5 人
        }
        const before = prev.find((m) => m.id === member.id)!;
        if (member.fatigue - before.fatigue > map.fatiguePerDay) {
          deaths += 1; // 疲劳增量超出基础值 = 当日阵亡(+阵亡疲劳罚)
        }
      }
      prev = output.state.members;
    }
    return { facade, deaths };
  }

  /** 累计经验 = 已消耗在各等级的经验 + 当前等级内经验(独立重算)。 */
  function totalXp(member: Member, startLevel: number): number {
    let consumed = 0;
    for (let level = startLevel; level < member.level; level++) {
      consumed += requiredXp(level);
    }
    return consumed + member.experience;
  }

  it('同一周练级:高效区经验与等级显著更多,疲劳打满;休闲区细水长流', () => {
    const intensive = runWeek('quarry-camp');
    const relaxed = runWeek('windmill-plains');
    const mapI = LEVELING_MAP_BY_ID.get('quarry-camp')!;
    const mapR = LEVELING_MAP_BY_ID.get('windmill-plains')!;

    const startLevels = new Map(new SimulationFacade(SEED, '星盾公会').state.members.map((m) => [m.id, m.level]));

    let levelSumI = 0;
    let levelSumR = 0;
    for (let id = 1; id <= 5; id++) {
      const mi = intensive.facade.state.members.find((m) => m.id === id)!;
      const mr = relaxed.facade.state.members.find((m) => m.id === id)!;
      const start = startLevels.get(id)!;

      // 经验(含已消耗部分):高效严格更多 —— 无论阵亡掷点如何,这是无随机界保证的不等式
      expect(totalXp(mi, start)).toBeGreaterThan(totalXp(mr, start));
      // 疲劳:高效 7×16=112 已打满 100;休闲 7×5+阵亡罚 < 100
      expect(mi.fatigue).toBe(LEVELING.maxFatigue);
      expect(mr.fatigue).toBeLessThan(LEVELING.maxFatigue);
      levelSumI += mi.level;
      levelSumR += mr.level;
    }
    // 等级总和:高效领先(经验优势远超一级所需)
    expect(levelSumI).toBeGreaterThan(levelSumR);
    // 两档基础参数本身:经验 3 倍以上、疲劳 3 倍以上、阵亡率数倍
    expect(mapI.xpPerDay / mapR.xpPerDay).toBeGreaterThanOrEqual(3);
    expect(mapI.fatiguePerDay / mapR.fatiguePerDay).toBeGreaterThanOrEqual(3);
    expect(mapI.deathChancePerDay / mapR.deathChancePerDay).toBeGreaterThanOrEqual(5);
  });

  it('阵亡损耗可观察:高效区一周内发生阵亡(经验损失 + 额外疲劳)', () => {
    const intensive = runWeek('quarry-camp');
    const relaxed = runWeek('windmill-plains');
    // 0.22/日×5 人×7 日,期望约 7-8 次;休闲区 0.03 同期期望约 1 次
    expect(intensive.deaths).toBeGreaterThanOrEqual(1);
    expect(intensive.deaths).toBeGreaterThan(relaxed.deaths);
  });

  it('疲劳压低经验效率:同样地图,高疲劳者日入经验更少', () => {
    const fresh = synthMember(1, 10, 0, 0);
    const tired = synthMember(2, 10, 0, 80);
    const state = stateWith([fresh, tired], [
      { id: 1, memberIds: [1, 2], activity: { type: 'leveling', mapId: 'quarry-camp' } },
    ]);
    const output = step(state, { deltaGameMinutes: GAME_MINUTES_PER_DAY });
    const freshXp = totalXp(output.state.members[0]!, 10);
    const tiredXp = totalXp(output.state.members[1]!, 10);
    expect(freshXp).toBeGreaterThan(tiredXp); // 效率 1.0 vs 0.6
  });
});

describe('休整与轮换(验收标准 2:疲劳恢复)', () => {
  it('停止练级回城休整:疲劳按 restFatiguePerDay 逐日恢复,下限 0', () => {
    const facade = setupLevelingSquad(SEED);
    facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId: 'quarry-camp' }, deltaGameMinutes: 0 });
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY * 4 }); // 疲劳积累到高位

    const stopped = facade.dispatch({ command: { type: 'stopLeveling', squadId: 1 }, deltaGameMinutes: 0 });
    expect(stopped.state.squads[0]!.activity).toBeUndefined();
    const atStop = structuredClone(facade.state.members);

    const rested = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    for (const old of atStop) {
      const after = rested.state.members.find((m) => m.id === old.id)!;
      expect(after.fatigue).toBe(Math.max(0, old.fatigue - LEVELING.restFatiguePerDay));
      // 休整只动疲劳;冷板凳计数是唯一例外(T12:队外者逐日 +1,在队者保持 0)
      const { benchDays: afterBench, ...afterRest } = after;
      const { benchDays: oldBench, ...oldRest } = old;
      expect({ ...afterRest, fatigue: 0 }).toEqual({ ...oldRest, fatigue: 0 });
      expect(afterBench).toBe(oldBench + (old.id === 6 ? 1 : 0)); // 夹具:仅第 6 人在队外
    }
    // 再休整多日:疲劳最终归零
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY * 7 });
    expect(facade.state.members.every((m) => m.fatigue === 0)).toBe(true);
  });

  it('待命团员(不在任何小队)同样享受休整恢复', () => {
    const facade = setupLevelingSquad(SEED); // 第 6 人始终在队外
    const benchBefore = facade.state.members[5]!;
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    const benchAfter = facade.state.members[5]!;
    expect(benchAfter.fatigue).toBe(Math.max(0, benchBefore.fatigue - LEVELING.restFatiguePerDay));
  });
});

describe('练级循环:确定性与序列化(验收标准 4)', () => {
  const runScript = (seed: number): string => {
    const facade = setupLevelingSquad(seed);
    facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId: 'quarry-camp' }, deltaGameMinutes: 0 });
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY * 3 });
    facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId: 'windmill-plains' }, deltaGameMinutes: 0 });
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    facade.dispatch({ command: { type: 'stopLeveling', squadId: 1 }, deltaGameMinutes: 0 });
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    return JSON.stringify(facade.state);
  };

  it('同一种子 + 同一脚本(含练级)⇒ 同状态(逐字节)', () => {
    expect(runScript(SEED)).toBe(runScript(SEED));
  });

  it('一次 7 日跳变 与 七次 1 日跳变 等价(边界逐日结算)', () => {
    const setup = () => {
      const facade = setupLevelingSquad(SEED);
      facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId: 'quarry-camp' }, deltaGameMinutes: 0 });
      return facade;
    };
    const bulk = setup();
    bulk.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK });
    const split = setup();
    for (let day = 0; day < 7; day++) {
      split.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    }
    expect(JSON.stringify(split.state)).toBe(JSON.stringify(bulk.state));
  });

  it('JSON 往返(存档路径):活动安排保留,恢复后可继续推进', () => {
    const facade = setupLevelingSquad(SEED);
    facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId: 'quarry-camp' }, deltaGameMinutes: 0 });
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });

    const resumed = new SimulationFacade(0, undefined, JSON.parse(JSON.stringify(facade.state)) as GameState);
    expect(resumed.state).toEqual(facade.state);
    const next = resumed.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(next.state.members.some((m) => m.fatigue >= LEVELING.maxFatigue || m.experience > 0)).toBe(true);
    // 恢复后的门面与连续推进的门面完全一致(可重放)
    const continuous = setupLevelingSquad(SEED);
    continuous.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId: 'quarry-camp' }, deltaGameMinutes: 0 });
    continuous.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY * 2 });
    expect(JSON.stringify(resumed.state)).toBe(JSON.stringify(continuous.state));
  });

  it('纯函数 step 不原地修改输入状态(练级路径)', () => {
    const facade = setupLevelingSquad(SEED);
    facade.dispatch({ command: { type: 'assignLevelingMap', squadId: 1, mapId: 'quarry-camp' }, deltaGameMinutes: 0 });
    const before = structuredClone(facade.state);
    const output = step(facade.state, { deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(facade.state).toEqual(before);
    const again = step(facade.state, { deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(again).toEqual(output);
  });
});
