import { describe, expect, it } from 'vitest';
import {
  GAME_MINUTES_PER_DAY,
  GAME_MINUTES_PER_WEEK,
  dayOfWeek,
  gameDay,
  gameWeek,
  minuteOfDay,
} from './clock';
import { DAILY_FLAVOR_POOL } from '../content/daily-flavor';
import { SimulationFacade, step, type SimInput } from './facade';
import type { SimEvent } from './events';
import type { GameState } from './state';

/**
 * 门面测试:全项目唯一测试接缝(不依赖 UI / DOM)。
 * 驱动方式 = 会长指令 + 游戏时间增量;断言 = 状态快照 + 事件日志。
 */

/** 指令 + 时间跳变的回放脚本(覆盖:改名、非法指令、跨日、跨周、指令与增量同步)。 */
const SCRIPT: readonly SimInput[] = [
  { command: { type: 'renameGuild', name: '  星盾远征军  ' }, deltaGameMinutes: 0 },
  { deltaGameMinutes: GAME_MINUTES_PER_DAY * 2 + 137 },
  { command: { type: 'renameGuild', name: '' }, deltaGameMinutes: 0 }, // 非法指令:应被忽略
  { deltaGameMinutes: GAME_MINUTES_PER_DAY },
  { deltaGameMinutes: GAME_MINUTES_PER_WEEK * 3 },
  { command: { type: 'renameGuild', name: '暮光酒馆' }, deltaGameMinutes: GAME_MINUTES_PER_DAY + 59 },
];

/** 跑完脚本,返回最终状态与全量事件(用于快照与日志断言)。 */
function replay(seed: number): { finalState: GameState; events: SimEvent[] } {
  const facade = new SimulationFacade(seed, '星盾公会');
  const events: SimEvent[] = [];
  for (const input of SCRIPT) {
    events.push(...facade.dispatch(input).events);
  }
  return { finalState: facade.state, events };
}

describe('模拟门面:确定性(验收标准 2)', () => {
  it('固定种子下,相同指令与时间增量序列产生相同状态与日志', () => {
    const first = replay(20261018);
    const second = replay(20261018);

    expect(second.finalState).toEqual(first.finalState);
    expect(second.events).toEqual(first.events);
    // 快照级一致:序列化逐字节比较
    expect(JSON.stringify(second.finalState)).toBe(JSON.stringify(first.finalState));
    expect(JSON.stringify(second.events)).toBe(JSON.stringify(first.events));
  });

  it('种子随机源生效:不同种子推进相同时间后随机链状态不同', () => {
    const a = replay(7);
    const b = replay(13);
    expect(a.finalState.rngState).not.toBe(b.finalState.rngState);
    expect(a.finalState.seed).toBe(7);
    expect(b.finalState.seed).toBe(13);
  });

  it('纯函数 step 不原地修改输入状态', () => {
    const facade = new SimulationFacade(99, '星盾公会');
    const before = structuredClone(facade.state);
    const output = step(facade.state, { deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(facade.state).toEqual(before); // 原状态未被改动
    expect(output.state).not.toBe(facade.state);
    // 同状态 + 同输入 ⇒ 同输出
    const again = step(facade.state, { deltaGameMinutes: GAME_MINUTES_PER_DAY });
    expect(again).toEqual(output);
  });
});

describe('模拟门面:指令与时间跳变(验收标准 3)', () => {
  it('指令 + 时间跳变驱动后,状态快照与日志符合预期', () => {
    const { finalState, events } = replay(20261018);

    // 状态快照:公会信息、游戏时钟及其派生量
    // (脚本累计游戏分钟:3017 + 1440 + 30240 + 1499 = 36196)
    expect(finalState.guild.name).toBe('暮光酒馆');
    expect(finalState.members).toHaveLength(6); // 建会名册:会长角色 + 5 名初始团员(T2)
    expect(finalState.clockGameMinutes).toBe(36196);
    expect(gameWeek(finalState.clockGameMinutes)).toBe(4);
    expect(gameDay(finalState.clockGameMinutes)).toBe(26);
    expect(dayOfWeek(finalState.clockGameMinutes)).toBe(4); // 周五
    expect(minuteOfDay(finalState.clockGameMinutes)).toBe(196); // 03:16

    // 事件日志:数量、顺序、内容
    // (T3 起,每个跨过的日界 = 日更 + 申请池刷新两条事件)
    expect(events).toHaveLength(55); // 2 条公会 + 25 条日更 + 25 条招募 + 3 条周更
    expect(events[0]?.kind).toBe('公会');
    expect(events[0]?.text).toBe('公会更名为「星盾远征军」。');
    expect(events.filter((e) => e.kind === '公会')).toHaveLength(2); // 空名指令被忽略
    expect(events.filter((e) => e.kind === '周更')).toHaveLength(3); // 第 2/3/4 周
    expect(events.filter((e) => e.kind === '周更').map((e) => e.text)).toEqual([
      '第 2 周开始,团本 CD 已重置。',
      '第 3 周开始,团本 CD 已重置。',
      '第 4 周开始,团本 CD 已重置。',
    ]);
    const dayEvents = events.filter((e) => e.kind === '日更');
    expect(dayEvents).toHaveLength(25); // 第 2..26 天
    expect(dayEvents.at(-1)?.text.startsWith('第 26 天:')).toBe(true);
    expect(events.filter((e) => e.kind === '招募')).toHaveLength(25); // 每个日界刷新一次申请池
    expect(events.at(-1)?.kind).toBe('招募'); // 日界结算顺序:日更 → 申请池刷新 →(周更)

    // 序号连续且递增
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: events.length }, (_, i) => i + 1));
  });

  it('日更风向文案来自内容池(数据驱动),且随机链状态随之推进', () => {
    const { finalState, events } = replay(20261018);
    const flavors = events
      .filter((e) => e.kind === '日更')
      .map((e) => e.text.replace(/^第 \d+ 天:/, ''));
    for (const flavor of flavors) {
      expect(DAILY_FLAVOR_POOL).toContain(flavor);
    }
    expect(finalState.rngState).not.toBe(finalState.seed); // 随机链已被消费
  });

  it('非法/无效指令:空名与重名均不改变状态、不产生事件', () => {
    const facade = new SimulationFacade(5, '星盾公会');
    const before = structuredClone(facade.state);

    expect(facade.dispatch({ command: { type: 'renameGuild', name: '   ' }, deltaGameMinutes: 0 }).events).toEqual([]);
    expect(facade.dispatch({ command: { type: 'renameGuild', name: '星盾公会' }, deltaGameMinutes: 0 }).events).toEqual([]);
    expect(facade.state).toEqual(before);
  });

  it('时间增量被取整并钳为非负:负数与浮点不破坏确定性', () => {
    const facade = new SimulationFacade(5, '星盾公会');
    facade.dispatch({ deltaGameMinutes: -100 });
    expect(facade.state.clockGameMinutes).toBe(0);
    facade.dispatch({ deltaGameMinutes: 12.9 });
    expect(facade.state.clockGameMinutes).toBe(12);
  });
});

describe('游戏时钟:日/周边界结算', () => {
  it('推进到周边界前一刻仍是第 1 周;跨过边界产生日更 + 申请池刷新 + 周更', () => {
    const facade = new SimulationFacade(21, '星盾公会');
    const before = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK - 1 });
    expect(gameWeek(facade.state.clockGameMinutes)).toBe(1);
    expect(before.events.every((e) => e.kind === '日更' || e.kind === '招募')).toBe(true);

    const crossing = facade.dispatch({ deltaGameMinutes: 1 });
    expect(gameWeek(facade.state.clockGameMinutes)).toBe(2);
    expect(crossing.events.map((e) => e.kind)).toEqual(['日更', '招募', '周更']);
    expect(crossing.events[2]?.text).toBe('第 2 周开始,团本 CD 已重置。');
    // 同一周边界上,事件时刻一致
    expect(new Set(crossing.events.map((e) => e.atGameMinutes)).size).toBe(1);
  });

  it('一次大跳变(数周)按时间顺序逐日逐周结算,事件时刻单调', () => {
    const facade = new SimulationFacade(33, '星盾公会');
    const output = facade.dispatch({ deltaGameMinutes: GAME_MINUTES_PER_WEEK * 2 + GAME_MINUTES_PER_DAY * 3 });
    const times = output.events.map((e) => e.atGameMinutes);
    expect([...times].sort((a, b) => a - b)).toEqual(times); // 单调不减
    expect(gameWeek(facade.state.clockGameMinutes)).toBe(3);
    expect(gameDay(facade.state.clockGameMinutes)).toBe(18);
  });
});
