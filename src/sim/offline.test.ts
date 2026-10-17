import { describe, expect, it } from 'vitest';
import { GEAR_SLOTS } from '../content/gear';
import { LEVELING } from '../content/maps';
import {
  REAL_MS_PER_REAL_DAY,
  GAME_MINUTES_PER_DAY,
  GAME_MINUTES_PER_WEEK,
  gameDay,
  gameWeek,
  realMsToGameMinutes,
} from './clock';
import {
  SAVE_KIND,
  SimulationFacade,
  decodeSave,
  decodeSaveEnvelope,
  encodeSave,
} from './facade';
import type { SimEvent } from './events';
import { activityQueue, nextSettlement } from './schedule';
import type { GearItem, GameState, Member, Squad } from './state';

/**
 * T9 门面测试:离线结算 + 日程页(模拟面)。
 * 离线 = 一次超长时间跳变:装配层把离线现实时长换算为游戏分钟、分段派发
 * (现实时间只在 src/main.ts,此处用纯换算函数复刻同一语义)。
 * 断言:分段与整跳等价(同速率、无上限、无惩罚)、长时间跳变的状态收束、
 * 大跳变补结算的性能(以测试超时为界,耗时见运行输出),以及存档时间戳封皮。
 * 全程只打门面接缝与 sim 纯函数(先例:leveling.test.ts / save.test.ts)。
 */

const SEED = 20261018;

/** 重载状态的小队编成:1 坦 + 1 奶 + 3 输出(满足进本门槛)。 */
const ROLE_SPECS = [
  { classId: 'warrior', specId: 'warrior-guard' },
  { classId: 'priest', specId: 'priest-light' },
  { classId: 'mage', specId: 'mage-arcane' },
  { classId: 'hunter', specId: 'hunter-beast' },
  { classId: 'rogue', specId: 'rogue-venom' },
] as const;

/** 合成团员:只填离线结算涉及的维度,其余取合法常量。 */
function synthMember(
  id: number,
  spec: (typeof ROLE_SPECS)[number],
  gearItemLevel: number,
  fatigue = 0,
): Member {
  return {
    id,
    isChairman: false,
    name: `重载团员${id}`,
    classId: spec.classId,
    specId: spec.specId,
    level: 12,
    experience: 0,
    gear: GEAR_SLOTS.map((slot) => ({ slot, quality: '蓝', itemLevel: gearItemLevel }) as GearItem),
    mood: 80,
    loyalty: 80,
    personalGold: 0,
    dkp: 0,
    fatigue,
    attendance: { styleId: 'iron', baseRate: 95 },
    traits: [],
    skillTierId: 'skilled',
  };
}

/**
 * 重载状态:8 支满编小队 + 会长角色,覆盖全部活动形态 ——
 * 3 支下本(普通/困难/英雄档,配高装等保证每日胜利与掉落)、
 * 3 支练级(高/中/低经验带的地图)、2 支休整(疲劳 55 与 0 两种起点)。
 * 时钟停在当日中途(137 分钟),随机链为建会初始链(同种子 ⇒ 同状态)。
 */
function heavyLoadState(): GameState {
  const base = new SimulationFacade(SEED, '重载公会').state;
  const members: Member[] = [];
  const squads: Squad[] = [];
  for (let squadIndex = 0; squadIndex < 8; squadIndex++) {
    const memberIds: number[] = [];
    for (let slot = 0; slot < 5; slot++) {
      const id = squadIndex * 5 + slot + 1;
      members.push(synthMember(id, ROLE_SPECS[slot]!, squadGear(squadIndex), squadFatigue(squadIndex)));
      memberIds.push(id);
    }
    squads.push({ id: squadIndex + 1, memberIds, ...squadActivity(squadIndex) });
  }
  // 会长角色不在任何小队:休整路径(疲劳 55 → 收束到 0)
  members.push({ ...synthMember(41, ROLE_SPECS[4]!, 30, 55), isChairman: true, name: '会长角色' });
  return {
    ...base,
    members,
    nextMemberId: 42,
    squads,
    nextSquadId: 9,
    clockGameMinutes: 137,
  };
}

/** 各小队的活动安排(下本配高装等 ⇒ 必胜档:每日都有掉落结算负载)。 */
function squadActivity(squadIndex: number): { activity?: Squad['activity'] } {
  switch (squadIndex) {
    case 0:
      return { activity: { type: 'dungeon', dungeonId: 'echo-catacomb' } };
    case 1:
      return { activity: { type: 'dungeon', dungeonId: 'bone-lyceum' } };
    case 2:
      return { activity: { type: 'leveling', mapId: 'emberdrake-waste' } };
    case 3:
      return { activity: { type: 'leveling', mapId: 'duskpine-sea' } };
    case 4:
      return { activity: { type: 'leveling', mapId: 'blackpine-hollow' } };
    case 6:
      return { activity: { type: 'dungeon', dungeonId: 'sandfury-altar' } };
    default:
      return {}; // 第 6/8 小队(序号 5/7):休整
  }
}

/** 下本小队按副本难度配装(保证必胜区间:战力 ≥ 难度 + winMargin)。 */
function squadGear(squadIndex: number): number {
  switch (squadIndex) {
    case 0:
      return 30; // 回声墓道 难度 36:(30+21)=51 ≥ 41
    case 1:
      return 75; // 白骨书院 难度 85:(75+21)=96 ≥ 90
    case 6:
      return 60; // 沙怒祭坛 难度 63:(60+21)=81 ≥ 68
    default:
      return 12;
  }
}

/** 休整小队 5 号给疲劳 55(验证恢复到 0 的收束),8 号保持 0。 */
function squadFatigue(squadIndex: number): number {
  return squadIndex === 5 ? 55 : 0;
}

/** 装配层离线补结算的接缝级复刻:现实时长 → 游戏分钟(取整)→ 按 1 游戏周分段派发。 */
function offlineCatchUp(start: GameState, elapsedRealMs: number): { state: GameState; events: SimEvent[] } {
  const facade = new SimulationFacade(0, undefined, structuredClone(start));
  let remaining = Math.floor(realMsToGameMinutes(Math.max(0, elapsedRealMs)));
  const events: SimEvent[] = [];
  while (remaining > 0) {
    const segment = Math.min(remaining, GAME_MINUTES_PER_WEEK);
    events.push(...facade.dispatch({ deltaGameMinutes: segment }).events);
    remaining -= segment;
  }
  return { state: facade.state, events };
}

/** 跨过的日界数 / 周界数(独立重算:只依赖起止时刻,不复用门面实现)。 */
function daysCrossed(from: number, to: number): number {
  return Math.floor(to / GAME_MINUTES_PER_DAY) - Math.floor(from / GAME_MINUTES_PER_DAY);
}
function weeksCrossed(from: number, to: number): number {
  return Math.floor(to / GAME_MINUTES_PER_WEEK) - Math.floor(from / GAME_MINUTES_PER_WEEK);
}

describe('离线结算:分段与整跳等价(验收标准 2 与 4 的正确性面)', () => {
  it('一次 20 游戏周大跳变 与 20 段逐周推进:状态与事件完全一致', () => {
    const start = heavyLoadState();
    const oneShot = new SimulationFacade(0, undefined, structuredClone(start));
    const oneShotEvents = oneShot.dispatch({
      deltaGameMinutes: GAME_MINUTES_PER_WEEK * 20,
    }).events;
    const chunked = new SimulationFacade(0, undefined, structuredClone(start));
    const chunkedEvents: SimEvent[] = [];
    for (let week = 0; week < 20; week++) {
      chunkedEvents.push(
        ...chunked.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK }).events,
      );
    }

    expect(chunked.state.clockGameMinutes).toBe(oneShot.state.clockGameMinutes);
    expect(JSON.stringify(chunked.state)).toBe(JSON.stringify(oneShot.state));
    // 事件流逐条一致(序号跨段连续):分段不改写历史
    expect(chunkedEvents).toEqual(oneShotEvents);
  });

  it('离线速率与在线一致:整跳 3 游戏日 与 在线逐分钟步进 4320 次完全一致', () => {
    const start = heavyLoadState();
    const oneShot = new SimulationFacade(0, undefined, structuredClone(start));
    const oneShotEvents = oneShot.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY * 3 }).events;
    const ticked = new SimulationFacade(0, undefined, structuredClone(start));
    const tickedEvents: SimEvent[] = [];
    for (let minute = 0; minute < GAME_MINUTES_PER_DAY * 3; minute++) {
      tickedEvents.push(...ticked.dispatch({ deltaGameMinutes: 1 }).events);
    }

    expect(JSON.stringify(ticked.state)).toBe(JSON.stringify(oneShot.state));
    expect(tickedEvents).toEqual(oneShotEvents);
  });

  it('速率常量全链路:离线 1 现实天 ⇒ 恰好推进 1 游戏周;离线 2 天一次结清 = 分两天结清', () => {
    const start = heavyLoadState();
    const oneDay = offlineCatchUp(start, REAL_MS_PER_REAL_DAY);
    expect(oneDay.state.clockGameMinutes).toBe(start.clockGameMinutes + GAME_MINUTES_PER_WEEK);

    // 无惩罚:一次离线 2 天 与 连续两次离线 1 天,状态与日志一致
    const twoAtOnce = offlineCatchUp(start, REAL_MS_PER_REAL_DAY * 2);
    const first = offlineCatchUp(start, REAL_MS_PER_REAL_DAY);
    const second = offlineCatchUp(first.state, REAL_MS_PER_REAL_DAY);
    expect(second.state.clockGameMinutes).toBe(twoAtOnce.state.clockGameMinutes);
    expect(JSON.stringify(second.state)).toBe(JSON.stringify(twoAtOnce.state));
    expect([...first.events, ...second.events]).toEqual(twoAtOnce.events);
  });
});

describe('离线结算:结果按序补齐(验收标准 1)', () => {
  it('离线 2 现实天回来:日界逐日结算、下本结果在列,事件按发生时刻有序且序号连续', () => {
    const start = heavyLoadState();
    const { state, events } = offlineCatchUp(start, REAL_MS_PER_REAL_DAY * 2);

    // 期间每个日界都补齐:日更/申请池逐日出现,下本结果按序在列
    expect(events.filter((e) => e.kind === '日更')).toHaveLength(
      daysCrossed(start.clockGameMinutes, state.clockGameMinutes),
    );
    expect(events.filter((e) => e.kind === '招募')).toHaveLength(
      daysCrossed(start.clockGameMinutes, state.clockGameMinutes),
    );
    const dungeonResults = events.filter((e) => e.kind === '下本');
    expect(dungeonResults.length).toBeGreaterThan(0);
    expect(dungeonResults.some((e) => e.text.includes('速通') || e.text.includes('败退'))).toBe(true);

    // 按序:序号从 1 连续递增,时刻单调不减,且都在离线窗口内
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: events.length }, (_, i) => i + 1));
    const times = events.map((e) => e.atGameMinutes);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    for (const time of times) {
      expect(time).toBeGreaterThan(start.clockGameMinutes);
      expect(time).toBeLessThanOrEqual(state.clockGameMinutes);
    }
    // 时钟精确走完离线时长对应的游戏时间
    expect(state.clockGameMinutes).toBe(start.clockGameMinutes + GAME_MINUTES_PER_WEEK * 2);
  });
});

describe('离线结算:长时间跳变的状态收束(验收标准 5)', () => {
  /** 一年量级的离线(52 游戏周 = 52 现实天)。 */
  const YEAR_JUMP = GAME_MINUTES_PER_WEEK * 52;

  it('52 游戏周跳变后:时钟精确、全员维度收束到定点、事件计数精确', () => {
    const start = heavyLoadState();
    const facade = new SimulationFacade(0, undefined, structuredClone(start));
    const { events } = facade.dispatch({ deltaGameMinutes: YEAR_JUMP });
    const state = facade.state;

    // 时钟精确前进(无截断、无重复)
    expect(state.clockGameMinutes).toBe(start.clockGameMinutes + YEAR_JUMP);
    expect(gameWeek(state.clockGameMinutes)).toBe(53); // 137 分钟起算,第 53 周
    // 事件计数精确:每个跨过的日界/周界各就各位
    expect(events.filter((e) => e.kind === '日更')).toHaveLength(
      daysCrossed(start.clockGameMinutes, state.clockGameMinutes),
    );
    expect(events.filter((e) => e.kind === '周更')).toHaveLength(
      weeksCrossed(start.clockGameMinutes, state.clockGameMinutes),
    );

    // 名册不增不减(自动层不产生人员变动)
    expect(state.members).toHaveLength(start.members.length);
    // 练级队员全部满级、经验清零(成长收束)
    for (const squadIndex of [2, 3, 4]) {
      for (const memberId of state.squads[squadIndex]!.memberIds) {
        const member = state.members.find((m) => m.id === memberId)!;
        expect(member.level).toBe(LEVELING.maxLevel);
        expect(member.experience).toBe(0);
      }
    }
    // 全员疲劳收束到轨面:活动中(练级/下本)= 100,休整 = 0
    for (const member of state.members) {
      expect([0, 100]).toContain(member.fatigue);
    }
    const activeIds = new Set(
      state.squads
        .filter((squad) => squad.activity !== undefined)
        .flatMap((squad) => squad.memberIds),
    );
    for (const member of state.members) {
      expect(member.fatigue).toBe(activeIds.has(member.id) ? 100 : 0);
    }
    // 装备只升不降(经济维度单调有界)
    for (const member of state.members) {
      const before = start.members.find((m) => m.id === member.id)!;
      expect(averageGear(before)).toBeLessThanOrEqual(averageGear(member));
    }
  });

  it('再离线一年:等级/经验/疲劳保持不动(收束为定点,后续跳变不再漂移)', () => {
    const start = heavyLoadState();
    // 连跳两年 vs 只跳一年:一年后维度已收束,第二年跳变不再改变人员维度
    const twoYears = new SimulationFacade(0, undefined, structuredClone(start));
    twoYears.dispatch({ deltaGameMinutes: YEAR_JUMP });
    twoYears.dispatch({ deltaGameMinutes: YEAR_JUMP });
    const oneYear = new SimulationFacade(0, undefined, structuredClone(start));
    oneYear.dispatch({ deltaGameMinutes: YEAR_JUMP });

    expect(twoYears.state.clockGameMinutes).toBe(start.clockGameMinutes + YEAR_JUMP * 2);
    const vitals = (state: GameState) =>
      state.members.map((m) => `${m.id}:${m.level}:${m.experience}:${m.fatigue}`).join('|');
    expect(vitals(twoYears.state)).toBe(vitals(oneYear.state));
  });
});

describe('离线结算:无上限、性能可接受(验收标准 2 与 4)', () => {
  it('超长离线(1040 游戏周 ≈ 2.85 现实年)一次结清:无截断、无异常、时钟精确', () => {
    const start = heavyLoadState();
    const facade = new SimulationFacade(0, undefined, structuredClone(start));
    const delta = GAME_MINUTES_PER_WEEK * 1040;
    const { events } = facade.dispatch({ deltaGameMinutes: delta });

    // 无上限:时钟精确走完全程,日界一个不少
    expect(facade.state.clockGameMinutes).toBe(start.clockGameMinutes + delta);
    expect(events.filter((e) => e.kind === '日更')).toHaveLength(
      daysCrossed(start.clockGameMinutes, facade.state.clockGameMinutes),
    );
    expect(gameDay(facade.state.clockGameMinutes)).toBeGreaterThan(7000);
    // 无惩罚:全员疲劳仍在轨面(不是被清空或冻结)
    for (const member of facade.state.members) {
      expect([0, 100]).toContain(member.fatigue);
    }
  }, 30_000);

  it('一年量级重载补结算(365 游戏周 × 8 小队全活动)在可接受时间内完成', () => {
    const start = heavyLoadState();
    const facade = new SimulationFacade(0, undefined, structuredClone(start));
    const delta = GAME_MINUTES_PER_WEEK * 365;
    const { events } = facade.dispatch({ deltaGameMinutes: delta });

    // 结算工作量精确(以此确认没有偷步:365 周的每一天都结算了)
    expect(events.filter((e) => e.kind === '日更')).toHaveLength(
      daysCrossed(start.clockGameMinutes, facade.state.clockGameMinutes),
    );
    expect(events.filter((e) => e.kind === '周更')).toHaveLength(
      weeksCrossed(start.clockGameMinutes, facade.state.clockGameMinutes),
    );
    expect(facade.state.clockGameMinutes).toBe(start.clockGameMinutes + delta);
    // 本测试的超时上限(20s)即性能验收线;实际耗时见运行输出
  }, 20_000);
});

describe('存档时间戳封皮:离线结算的起测点(验收标准 1 与 2 的格式面)', () => {
  it('encodeSave 带时间戳 → decodeSaveEnvelope 取回状态与时间戳;缺省为 0', () => {
    const state = heavyLoadState();
    const stamped = decodeSaveEnvelope(encodeSave(state, 1_760_000_000_000));
    expect(stamped).not.toBeNull();
    expect(stamped!.savedAtMs).toBe(1_760_000_000_000);
    expect(stamped!.state).toEqual(state);

    const plain = decodeSaveEnvelope(encodeSave(state));
    expect(plain!.savedAtMs).toBe(0);
    // 旧便捷入口保持兼容:只取状态
    expect(decodeSave(encodeSave(state, 42))).toEqual(state);
  });

  it('v4 旧档(无 savedAtMs)迁移可读,时间基准按 0 处理(不触发补结算)', () => {
    const state = heavyLoadState();
    const v4File = JSON.stringify({ kind: SAVE_KIND, version: 4, state });
    const decoded = decodeSaveEnvelope(v4File);
    expect(decoded).not.toBeNull();
    expect(decoded!.savedAtMs).toBe(0);
    expect(decoded!.state).toEqual(state);
  });

  it('时间戳防御:负数/非数字/JSON 损坏一律按无基准或拒绝,不产生负的离线时长', () => {
    const state = heavyLoadState();
    const negative = decodeSaveEnvelope(
      JSON.stringify({ kind: SAVE_KIND, version: 5, savedAtMs: -5, state }),
    );
    expect(negative!.savedAtMs).toBe(0);
    const garbage = decodeSaveEnvelope(
      JSON.stringify({ kind: SAVE_KIND, version: 5, savedAtMs: '不是数字', state }),
    );
    expect(garbage!.savedAtMs).toBe(0);
    expect(decodeSaveEnvelope('不是 JSON')).toBeNull();
  });
});

describe('日程派生量:活动队列与下一场倒计时(验收标准 3)', () => {
  it('活动队列按编成顺序列出全部已排活动,休整小队不在列', () => {
    const queue = activityQueue(heavyLoadState());
    expect(queue.map((entry) => entry.kind)).toEqual(['下本', '下本', '练级', '练级', '练级', '下本']);
    expect(queue.map((entry) => entry.squadOrdinal)).toEqual([1, 2, 3, 4, 5, 7]);
    expect(queue[0]).toMatchObject({ name: '回声墓道', tier: '普通', perDay: 2 });
    expect(queue[2]).toMatchObject({ name: '烬龙荒原', tier: '高效', perDay: 120000 });
  });

  it('下一场结算 = 下一个日界;剩余分钟随时钟缩小;周边界叠加标注', () => {
    const state = heavyLoadState(); // 时钟 137(当日 02:17)
    const countdown = nextSettlement(state);
    expect(countdown.atGameMinutes).toBe(GAME_MINUTES_PER_DAY);
    expect(countdown.remainingGameMinutes).toBe(GAME_MINUTES_PER_DAY - 137);
    expect(countdown.isWeekBoundary).toBe(false);

    // 推进到日界后,倒计时翻到下一个日界
    const facade = new SimulationFacade(0, undefined, structuredClone(state));
    facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_DAY - 137 });
    expect(nextSettlement(facade.state).atGameMinutes).toBe(GAME_MINUTES_PER_DAY * 2);

    // 第 7 个日界 = 周边界(周更:团本 CD 重置)
    const weekEdge = { ...state, clockGameMinutes: GAME_MINUTES_PER_WEEK - 1 };
    const weekCountdown = nextSettlement(weekEdge);
    expect(weekCountdown.atGameMinutes).toBe(GAME_MINUTES_PER_WEEK);
    expect(weekCountdown.remainingGameMinutes).toBe(1);
    expect(weekCountdown.isWeekBoundary).toBe(true);
  });
});

/** 装等合计(收束断言用:只比较总量,不重用 sim 的派生函数)。 */
function averageGear(member: Member): number {
  return member.gear.reduce((sum, item) => sum + item.itemLevel, 0);
}
